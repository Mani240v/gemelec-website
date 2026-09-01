const crypto = require('node:crypto')
const { appendRow, updateRowCells } = require('./_lib/sheets')
const { putPhoto, configured: photoStoreConfigured } = require('./_lib/photo-store')
const { draftCosting } = require('./_lib/anthropic')
const { money, SUBTOTAL_CAP } = require('./_lib/price-book')
const { sendNotification } = require('./_lib/email')
const { sendWhatsAppNotification } = require('./_lib/whatsapp')

const HEADERS = [
  'submitted_at',
  'request_id',
  'source',
  'page_url',
  'full_name',
  'phone',
  'email',
  'job_address',
  'description',
  'photo_links',
  'ai_summary',
  'ai_draft_costing',
  'ai_estimate_low',
  'ai_estimate_high',
  'ai_status',
  'status',
  'notes',
  // Appended 2026-09-01 for the field portal. APPEND ONLY, never insert: appendRow writes
  // positionally by this array, and getRows reads back by the SHEET's own header row, so a
  // new name in the middle would silently shift every later column of every future row.
  // Until the matching labels are pasted into row 1 of the sheet these are written but not
  // read back — harmless in both directions, which is what makes the migration safe.
  'client_type',
  'returning_customer',
  'site_contact',
  'billing_address',
  'billing_email'
]

const MAX_PHOTOS = 5
const MAX_PHOTO_BYTES = 3 * 1024 * 1024 // decoded size, per photo
const MAX_BODY_BYTES = 4.5 * 1024 * 1024 // matches Vercel's serverless function request-body ceiling
const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp']

// vercel.json caps this function at 60s. Everything that actually tells Mani a lead exists
// runs AFTER the model call — the sheet write-back (which mints a second OAuth token), the
// Resend email carrying up to ~4MB of photo attachments, and the Twilio WhatsApp push —
// and none of those carry a timeout of their own. Left to itself draftCosting measured its
// own 50s deadline from the moment it started, i.e. after the uploads and the append, so a
// slow Opus 5 turn ran the invocation past 60s and the platform killed it: row saved,
// no email, no WhatsApp, and the customer told "Sorry, that could not be sent" so they
// resubmit and Mani gets two rows for one job. The AI now gets what is genuinely left.
// 5s under maxDuration, for the platform's own overhead. maxDuration is 90s in
// vercel.json: at 60 this left the estimator ~29s once five photos had been parsed and
// uploaded, and Opus 5 at effort 'high' over a 208-item catalogue and five images does
// not reliably answer in that — a live submission on 2026-09-01 timed out at 29308ms and
// produced no estimate at all. OVERALL_DEADLINE_MS (50s) in anthropic.js is the binding
// cap now rather than this one, which is the right way round: the model's ceiling should
// be a deliberate number, not whatever the platform happened to leave over.
const FUNCTION_BUDGET_MS = 85000
const ALERT_RESERVE_MS = 15000 // write-back + email with attachments + WhatsApp
const ALERT_SEND_RESERVE_MS = 9000 // of that reserve, what the two alerts keep for themselves
const MIN_AI_BUDGET_MS = 20000 // below this, skip the model rather than pay for a timeout

// /api/job-request has no auth, no CAPTCHA and no rate limit — only the company_website
// honeypot, which a scripted client simply omits. One submission can bill up to 16,000
// Opus 5 output tokens. This is a per-instance ceiling on the AI STEP ONLY: past it the
// lead is still saved, the email and WhatsApp still go out, Mani just prices that one by
// hand. It is a blast-radius cap, not a real rate limiter — Vercel runs many instances and
// recycles them, so a distributed flood still gets through. Durable limiting needs shared
// state this repo deliberately does not have.
const AI_CALLS_PER_WINDOW = 40
const AI_WINDOW_MS = 60 * 60 * 1000
const aiCallTimes = []

function claimAiBudget() {
  const cutoff = Date.now() - AI_WINDOW_MS
  while (aiCallTimes.length && aiCallTimes[0] < cutoff) aiCallTimes.shift()
  if (aiCallTimes.length >= AI_CALLS_PER_WINDOW) return false
  aiCallTimes.push(Date.now())
  return true
}

// Never let a hung dependency eat the customer's response. The work keeps running; we just
// stop waiting on it.
function withDeadline(promise, ms, label) {
  let timer
  return Promise.race([
    promise,
    new Promise(resolve => {
      timer = setTimeout(() => {
        console.error(`${label} did not finish within ${ms}ms — carrying on without it`)
        resolve({ timedOut: true })
      }, ms)
    })
  ]).finally(() => clearTimeout(timer))
}

// Written into ai_draft_costing while the AI draft is still running, so the dashboard says
// so instead of showing "No AI draft available", which is what it says for a genuine
// failure. Renders correctly on the existing dashboard with no JS change: the summary
// shows, the range line stays hidden because it is gated on line_items.length, and the
// empty editable pricing table appears as normal.
const PENDING_COSTING = JSON.stringify({
  summary: 'Estimate is still being worked out — reload in a minute. If it never appears, price this one manually.',
  line_items: [],
  flagged_items: [],
  estimate_low: '',
  estimate_high: ''
})

// appendRow's own response names the row it wrote (e.g. 'Job Requests'!A42:Q42), so the
// costing can be patched in afterwards without a second read of the sheet.
function appendedRowNumber(appendResult) {
  const match = String(appendResult?.updates?.updatedRange || '').match(/![A-Z]+(\d+)(?::|$)/)
  return match ? Number(match[1]) : null
}

const JOB_REQUESTS_SHEET_ID = process.env.JOB_REQUESTS_SHEET_ID
const JOB_REQUESTS_SHEET_TAB = process.env.JOB_REQUESTS_SHEET_TAB || 'Job Requests'

function send(res, statusCode, payload) {
  res.statusCode = statusCode
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(payload))
}

function getBody(req) {
  if (req.body && typeof req.body === 'object') return req.body
  if (typeof req.body === 'string') return JSON.parse(req.body || '{}')

  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', chunk => {
      body += chunk
      if (body.length > MAX_BODY_BYTES) {
        req.destroy()
        reject(new Error('Request body too large'))
      }
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(body || '{}'))
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })
}

function clean(value, maxLength = 1000) {
  return String(value || '').trim().slice(0, maxLength)
}

function estimateBase64Bytes(base64) {
  return Math.floor((base64.length * 3) / 4)
}

// Single-pass character scans, no backtracking — these run over strings up to ~4MB.
function isBase64(value) {
  if (value.length % 4 !== 0) return false
  if (/[^A-Za-z0-9+/=]/.test(value)) return false
  return !/=[^=]/.test(value) // padding only at the end
}

// The declared mimeType is chosen by the client and is passed straight through to the
// Anthropic image block as media_type, so it has to match what the bytes actually are.
// Without this, `{mimeType: 'image/jpeg', base64: 'not-an-image'}` on an otherwise valid
// lead made every draft 400 — recorded as failed:http_400, which is the exact signature
// the rollout notes tell Mani means the account is under zero-data-retention or the schema
// was rejected. Free to send, and it sends him debugging the wrong thing.
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function looksLikeDeclaredImage(base64, mimeType) {
  let head
  try {
    head = Buffer.from(base64.slice(0, 32), 'base64')
  } catch {
    return false
  }
  if (head.length < 12) return false
  if (mimeType === 'image/jpeg') return head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff
  if (mimeType === 'image/png') return head.subarray(0, 8).equals(PNG_MAGIC)
  if (mimeType === 'image/webp') {
    return head.subarray(0, 4).toString('latin1') === 'RIFF' &&
      head.subarray(8, 12).toString('latin1') === 'WEBP'
  }
  return false
}

function validatePhotos(photos) {
  if (photos == null || (Array.isArray(photos) && photos.length === 0)) {
    return { valid: true }
  }
  if (!Array.isArray(photos)) {
    return { valid: false, error: 'Photos were not received correctly. Please try again.' }
  }
  if (photos.length > MAX_PHOTOS) {
    return { valid: false, error: `Please attach at most ${MAX_PHOTOS} photos.` }
  }
  for (const photo of photos) {
    if (!photo || typeof photo.base64 !== 'string' || !photo.base64) {
      return { valid: false, error: 'One of the photos could not be read. Please try again.' }
    }
    if (!ALLOWED_MIME_TYPES.includes(photo.mimeType)) {
      return { valid: false, error: 'Photos must be JPEG, PNG, or WebP.' }
    }
    if (estimateBase64Bytes(photo.base64) > MAX_PHOTO_BYTES) {
      return { valid: false, error: 'One of the photos is too large. Please try again.' }
    }
    if (!isBase64(photo.base64) || !looksLikeDeclaredImage(photo.base64, photo.mimeType)) {
      return { valid: false, error: 'One of the photos could not be read. Please try again.' }
    }
  }
  return { valid: true }
}

module.exports = async function handler(req, res) {
  const invocationStartedAt = Date.now()
  // Every downstream deadline is taken from this rather than from a fixed constant, so the
  // stages cannot each claim the reserve and sum past maxDuration between them.
  const remainingMs = () => FUNCTION_BUDGET_MS - (Date.now() - invocationStartedAt)

  if (req.method === 'OPTIONS') {
    res.setHeader('Allow', 'POST, OPTIONS')
    return send(res, 204, {})
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return send(res, 405, { ok: false, message: 'Method not allowed' })
  }

  try {
    const body = await getBody(req)

    if (clean(body.company_website)) {
      return send(res, 200, { ok: true })
    }

    const requiredFields = ['full_name', 'phone', 'description']
    const missingFields = requiredFields.filter(field => !clean(body[field]))
    const photoCheck = validatePhotos(body.photos)
    if (!photoCheck.valid) missingFields.push('photos')

    if (missingFields.length) {
      return send(res, 400, {
        ok: false,
        message: !photoCheck.valid ? photoCheck.error : 'Please complete the required fields before sending.',
        missingFields
      })
    }

    const requestId = `job-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`
    const description = clean(body.description, 3000)
    const photos = Array.isArray(body.photos) ? body.photos : []

    // Photo upload and the AI draft are best-effort — a failure in either must never
    // stop the customer's request from being recorded. Sheet append is the one step
    // that has to succeed for the submission to count.
    // Photo upload and the AI draft are best-effort — a failure in either must never
    // stop the customer's request from being recorded. Sheet append is the one step
    // that has to succeed for the submission to count.
    //
    // photo_links holds Blob PATHNAMES now, not URLs. Private blobs are not fetchable by
    // URL, so a URL here would look like a working link and never be one; the dashboard
    // reads these through /api/job-photo. Rows written before 2026-09-01 still hold Drive
    // URLs, and the dashboard tells the two apart rather than migrating them.
    const photoLinks = []
    if (photos.length && photoStoreConfigured()) {
      for (const [index, photo] of photos.entries()) {
        try {
          photoLinks.push(await putPhoto(requestId, index, photo.mimeType, photo.base64))
        } catch (error) {
          // No fail-fast here, unlike the Drive code this replaces. A Drive failure was a
          // configuration fact that repeated identically for every photo; a Blob failure is
          // far more likely to be about this one upload, so the remaining photos still get
          // their turn.
          console.error(`Photo upload failed (${index + 1}/${photos.length}):`, error)
        }
      }
    } else if (photos.length) {
      console.error('BLOB_READ_WRITE_TOKEN not configured — skipping photo upload')
    }

    const row = {
      submitted_at: new Date().toISOString(),
      request_id: requestId,
      source: clean(body.source) || 'website',
      page_url: clean(body.page_url, 2000),
      full_name: clean(body.full_name, 250),
      phone: clean(body.phone, 100),
      email: clean(body.email, 250),
      job_address: clean(body.job_address, 500),
      description,
      photo_links: photoLinks.join(', '),
      // Field-portal extras. The customer form never sends these, so they stay blank there.
      // Normalised to a closed set rather than passed through: these drive what the office
      // does about contacts and billing, and 'Commercial ' with a stray space would quietly
      // read as a different value from 'commercial'.
      client_type: clean(body.client_type, 20).toLowerCase() === 'commercial' ? 'commercial' : 'residential',
      returning_customer: body.returning_customer === true ? 'RETURNING' : '',
      site_contact: clean(body.site_contact, 250),
      billing_address: clean(body.billing_address, 500),
      billing_email: clean(body.billing_email, 250),
      ai_summary: '',
      ai_draft_costing: PENDING_COSTING,
      ai_estimate_low: '',
      ai_estimate_high: '',
      ai_status: 'pending',
      status: 'new',
      notes: ''
    }

    // The row goes in BEFORE the AI draft, not after it. The draft is best-effort; the
    // lead is the business. Written the other way round, a slow model call means the
    // platform kills the function mid-flight and the customer's request is lost outright
    // — no row, no email, no WhatsApp — and Opus 5's turns are long enough on a job with
    // photos to make that a routine outcome rather than a rare one.
    const appendResult = await appendRow(JOB_REQUESTS_SHEET_ID, JOB_REQUESTS_SHEET_TAB, HEADERS, row)
      .catch(error => {
        console.error('Job request sheet append failed:', error)
        return null
      })

    if (!appendResult) {
      console.error('Job request not captured:', requestId)
      return send(res, 500, {
        ok: false,
        message: 'Sorry, that could not be sent. Please call 0498 351 351 or email info@gemelec.sydney.'
      })
    }

    const rowNumber = appendedRowNumber(appendResult)

    // Every failure mode inside draftCosting — a 400 on a parameter Opus 5 rejects, a
    // refusal, a truncation, a timeout, a total outside the plausible band — throws and is
    // caught right here, so it can never reach the outer catch and turn a missing estimate
    // into a lost lead.
    let aiDraft = null
    let aiStatus = 'failed'
    // Whatever is left of the invocation once the alerts have their reserve. On a
    // five-photo submission the uploads and the append have already spent several seconds
    // of it, and that is exactly the case where the old fixed 50s overran.
    const aiBudgetMs = remainingMs() - ALERT_RESERVE_MS

    if (aiBudgetMs < MIN_AI_BUDGET_MS) {
      console.error(`Skipping AI costing: only ${aiBudgetMs}ms left of the invocation`)
      aiStatus = 'failed:no-time'
    } else if (!claimAiBudget()) {
      console.error('Skipping AI costing: per-instance hourly ceiling reached')
      aiStatus = 'failed:rate-limited'
    } else {
      try {
        aiDraft = await draftCosting({
          description,
          photos: photos.map(photo => ({ mimeType: photo.mimeType, base64: photo.base64 })),
          budgetMs: aiBudgetMs
        })
        aiStatus = aiDraft.ai_status || 'ok'
      } catch (error) {
        console.error('AI costing draft failed:', error)
        aiStatus = error.aiStatus || 'failed'
      }
    }

    const hasLines = Boolean(aiDraft && aiDraft.line_items.length)
    // A withheld estimate (over the ceiling) still has a real itemisation behind it, so
    // "did we price anything" and "is there a range to print" are now different questions.
    const hasRange = Boolean(
      aiDraft && Number.isFinite(aiDraft.estimate_low) && Number.isFinite(aiDraft.estimate_high)
    )

    let writeBackOk = true
    if (rowNumber) {
      const writeBack = await withDeadline(
        updateRowCells(JOB_REQUESTS_SHEET_ID, JOB_REQUESTS_SHEET_TAB, rowNumber, HEADERS, {
          ai_summary: aiDraft?.summary || '',
          ai_draft_costing: aiDraft ? JSON.stringify(aiDraft) : '',
          ai_estimate_low: hasRange ? aiDraft.estimate_low : '',
          ai_estimate_high: hasRange ? aiDraft.estimate_high : '',
          ai_status: aiStatus
        }).catch(error => {
          console.error('AI costing write-back failed:', error)
          return { failed: true }
        }),
        Math.max(4000, remainingMs() - ALERT_SEND_RESERVE_MS),
        'AI costing write-back'
      )
      writeBackOk = !(writeBack && (writeBack.failed || writeBack.timedOut))
    } else {
      writeBackOk = false
    }

    // Photos ride along as email attachments on every submission. This is the archive:
    // the Blob copy behind the dashboard is purged after 14 days, the mailbox is not.
    const photoAttachments = photos.map((photo, index) => ({
      filename: `photo-${index + 1}.${photo.mimeType.split('/')[1] || 'jpg'}`,
      content: photo.base64,
      content_type: photo.mimeType
    }))

    // Branches on whether anything was priced, not on the figure. An honest "I could not
    // match this to your price list" is zero, and printing that as "$0 - $0" reads like a
    // genuine no-charge job.
    const flaggedCount = aiDraft ? aiDraft.flagged_items.length : 0
    let estimateLine
    if (!aiDraft) {
      estimateLine = 'AI draft estimate: not available for this one — review manually.'
    } else if (hasRange) {
      // Two figures on purpose. The list total is the worst case; the discounted one is
      // what Mani normally charges, and it is the number he actually wants at a glance on
      // his phone. confidence_pct is about the item picks, not the prices.
      const discountLabel = Number.isFinite(aiDraft.discount_pct)
        ? ` (${Math.round(aiDraft.discount_pct * 100)}% off list)`
        : ''
      estimateLine = [
        `AI draft estimate: $${money(aiDraft.estimate_low)} - $${money(aiDraft.estimate_high)}` +
          ' (from your price list, review before quoting' +
          `${flaggedCount ? `; ${flaggedCount} item${flaggedCount === 1 ? '' : 's'} flagged` : ''})`,
        Number.isFinite(aiDraft.subtotal) && Number.isFinite(aiDraft.typical_subtotal)
          ? `  List total $${money(aiDraft.subtotal)} / your price $${money(aiDraft.typical_subtotal)}${discountLabel}`
          : '',
        Number.isFinite(aiDraft.confidence_pct)
          ? `  AI confidence in the item picks: ${aiDraft.confidence_pct}%`
          : ''
      ].filter(Boolean).join('\n')
    } else if (hasLines) {
      estimateLine = `AI draft estimate: the items come to more than $${money(SUBTOTAL_CAP)}, which is ` +
        'above the ceiling this system will put a number on — the itemisation is on the dashboard, total it yourself.'
    } else {
      estimateLine = 'AI draft estimate: nothing matched your price list — price this one manually.'
    }

    // Said out loud rather than left to be discovered. If the write-back did not land, the
    // dashboard card still reads "Estimate is still being worked out — reload in a minute"
    // and will say that forever, while this alert carries a real figure. Nothing retries
    // and nothing reconciles, so the two channels Mani triages on would silently disagree.
    const writeBackLine = writeBackOk
      ? ''
      : 'Note: the dashboard row could not be updated with this draft, so the card there will still say the estimate is being worked out. This alert is the copy of record.'

    await withDeadline(Promise.all([
      sendNotification({
        subject: `New job request — ${row.full_name}`,
        text: [
          `${row.full_name} (${row.phone}) sent a new job request.`,
          '',
          row.email
            ? `Email: ${row.email}  (replying to this alert goes straight to them)`
            : 'Email: not given — reply goes to the office inbox, so call them instead.',
          `Address: ${row.job_address || 'not given'}`,
          `Description: ${description}`,
          '',
          estimateLine,
          writeBackLine,
          '',
          photoAttachments.length ? `Photos attached to this email (${photoAttachments.length}).` : '',
          'Review: https://www.gemelec.com.au/job-requests',
          JOB_REQUESTS_SHEET_ID ? `Sheet: https://docs.google.com/spreadsheets/d/${JOB_REQUESTS_SHEET_ID}/edit` : ''
        ].filter(Boolean).join('\n'),
        // Always attach, even when the upload succeeded. Blob holds photos for 14 days
        // only, so the email is the permanent archive — dropping the attachments because a
        // copy exists would mean the copy is the ONLY one, and it expires.
        attachments: photoAttachments,
        replyTo: row.email
      }),
      sendWhatsAppNotification(
        [
          `New job request — ${row.full_name} (${row.phone})`,
          row.job_address ? `Address: ${row.job_address}` : '',
          `Job: ${description.slice(0, 400)}`,
          estimateLine,
          writeBackLine,
          'Review: https://www.gemelec.com.au/job-requests'
        ].filter(Boolean).join('\n')
      )
    ]), Math.max(3000, remainingMs()), 'Job request alerts')

    return send(res, 200, {
      ok: true,
      requestId,
      message: "Thanks — we've received your details. We'll be in touch with a quote shortly."
    })
  } catch (error) {
    console.error('Job request submit failed:', error)
    return send(res, 500, {
      ok: false,
      message: 'Sorry, that could not be sent. Please call 0498 351 351 or email info@gemelec.sydney.'
    })
  }
}
