const crypto = require('node:crypto')
const { appendRow } = require('./_lib/sheets')
const { uploadPhotoToDrive } = require('./_lib/google-drive')
const { draftCosting } = require('./_lib/anthropic')
const { sendNotification } = require('./_lib/email')
const priceList = require('./price-list.json')

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
  'notes'
]

const MAX_PHOTOS = 5
const MAX_PHOTO_BYTES = 3 * 1024 * 1024 // decoded size, per photo
const MAX_BODY_BYTES = 4.5 * 1024 * 1024 // matches Vercel's serverless function request-body ceiling
const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp']

const DRIVE_FOLDER_ID = process.env.DRIVE_FOLDER_ID
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
  }
  return { valid: true }
}

module.exports = async function handler(req, res) {
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
    const photoLinks = []
    if (DRIVE_FOLDER_ID && photos.length) {
      for (const [index, photo] of photos.entries()) {
        try {
          const uploaded = await uploadPhotoToDrive(
            DRIVE_FOLDER_ID,
            `${requestId}-${index + 1}.jpg`,
            photo.mimeType,
            photo.base64
          )
          photoLinks.push(uploaded.viewUrl)
        } catch (error) {
          console.error('Photo upload failed:', error)
        }
      }
    } else if (photos.length && !DRIVE_FOLDER_ID) {
      console.error('DRIVE_FOLDER_ID not configured — skipping photo upload')
    }

    let aiDraft = null
    let aiStatus = 'skipped'
    try {
      aiDraft = await draftCosting({
        description,
        priceList,
        photos: photos.map(photo => ({ mimeType: photo.mimeType, base64: photo.base64 }))
      })
      aiStatus = 'ok'
    } catch (error) {
      console.error('AI costing draft failed:', error)
      aiStatus = 'failed'
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
      ai_summary: aiDraft?.summary || '',
      ai_draft_costing: aiDraft ? JSON.stringify(aiDraft) : '',
      ai_estimate_low: aiDraft?.estimate_low ?? '',
      ai_estimate_high: aiDraft?.estimate_high ?? '',
      ai_status: aiStatus,
      status: 'new',
      notes: ''
    }

    const sheetSaved = await appendRow(JOB_REQUESTS_SHEET_ID, JOB_REQUESTS_SHEET_TAB, HEADERS, row)
      .then(() => true)
      .catch(error => {
        console.error('Job request sheet append failed:', error)
        return false
      })

    if (!sheetSaved) {
      console.error('Job request not captured:', requestId)
      return send(res, 500, {
        ok: false,
        message: 'Sorry, that could not be sent. Please call 0498 351 351 or email info@gemelec.sydney.'
      })
    }

    // Photos ride along as email attachments rather than a Drive link — the service
    // account has no Drive storage quota of its own (see uploadPhotoToDrive above,
    // best-effort and usually a no-op until that's set up with domain-wide delegation).
    const photoAttachments = photos.map((photo, index) => ({
      filename: `photo-${index + 1}.${photo.mimeType.split('/')[1] || 'jpg'}`,
      content: photo.base64,
      content_type: photo.mimeType
    }))

    await sendNotification({
      subject: `New job request — ${row.full_name}`,
      text: [
        `${row.full_name} (${row.phone}) sent a new job request.`,
        '',
        `Address: ${row.job_address || 'not given'}`,
        `Description: ${description}`,
        '',
        aiDraft
          ? `AI draft estimate: $${aiDraft.estimate_low} - $${aiDraft.estimate_high} (review before quoting)`
          : 'AI draft estimate: not available for this one — review manually.',
        '',
        !photoLinks.length && photoAttachments.length ? `Photos attached to this email (${photoAttachments.length}).` : '',
        'Review: https://www.gemelec.com.au/job-requests',
        JOB_REQUESTS_SHEET_ID ? `Sheet: https://docs.google.com/spreadsheets/d/${JOB_REQUESTS_SHEET_ID}/edit` : ''
      ].filter(Boolean).join('\n'),
      attachments: photoLinks.length ? undefined : photoAttachments
    })

    return send(res, 200, {
      ok: true,
      requestId,
      message: "Thanks — we've received your photos and details. We'll be in touch with a quote shortly."
    })
  } catch (error) {
    console.error('Job request submit failed:', error)
    return send(res, 500, {
      ok: false,
      message: 'Sorry, that could not be sent. Please call 0498 351 351 or email info@gemelec.sydney.'
    })
  }
}
