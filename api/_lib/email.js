const RESEND_API_URL = 'https://api.resend.com/emails'

// Internal-only notification (e.g. "new job request in the dashboard") — never used to
// email a customer. Missing config degrades gracefully: caller treats a false return as
// non-fatal, best-effort only.
async function sendNotification({ subject, text, attachments }) {
  const apiKey = process.env.RESEND_API_KEY
  const from = process.env.NOTIFY_EMAIL_FROM
  const to = process.env.NOTIFY_EMAIL_TO
  const cc = process.env.NOTIFY_EMAIL_CC

  if (!apiKey || !from || !to) return false

  try {
    const body = { from, to, subject, text }
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

module.exports = { sendNotification }
