const RESEND_API_URL = 'https://api.resend.com/emails'

// A single address, with no separators or newlines that could inject extra headers.
// `clean()` upstream only trims and truncates, so anything typed into the form arrives here
// unvalidated.
const EMAIL_RE = /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$/

function validEmail(value) {
  const trimmed = String(value || '').trim()
  return EMAIL_RE.test(trimmed) ? trimmed : null
}

// Internal-only notification (e.g. "new job request in the dashboard") — never used to
// email a customer. Missing config degrades gracefully: caller treats a false return as
// non-fatal, best-effort only.
//
// `replyTo` is the address a reply should reach, normally the customer who submitted the
// form. NOTIFY_EMAIL_FROM is a no-reply address with no mailbox behind it, so without this
// every reply bounces with 550 "address not found" and the customer hears nothing. An
// invalid or missing value falls back to NOTIFY_EMAIL_TO so a reply still lands somewhere
// real rather than bouncing.
async function sendNotification({ subject, text, attachments, replyTo }) {
  const apiKey = process.env.RESEND_API_KEY
  const from = process.env.NOTIFY_EMAIL_FROM
  const to = process.env.NOTIFY_EMAIL_TO
  const cc = process.env.NOTIFY_EMAIL_CC

  if (!apiKey || !from || !to) return false

  try {
    const body = { from, to, subject, text }
    body.reply_to = validEmail(replyTo) || to
    if (cc) body.cc = cc
    if (attachments && attachments.length) body.attachments = attachments

    const response = await fetch(RESEND_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    })

    if (!response.ok) {
      console.error('Notification email failed:', response.status, await response.text().catch(() => ''))
      return false
    }

    return true
  } catch (error) {
    console.error('Notification email failed:', error)
    return false
  }
}

module.exports = { sendNotification, validEmail }
