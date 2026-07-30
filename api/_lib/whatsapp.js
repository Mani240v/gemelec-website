const TWILIO_API_BASE = 'https://api.twilio.com/2010-04-01/Accounts'

// Internal-only WhatsApp alert (mirrors email.js's sendNotification) — never used to
// message a customer. Sent via Twilio's WhatsApp API (hand-rolled fetch + Basic Auth,
// no Twilio SDK, consistent with the rest of this repo's zero-npm-dep convention).
// Missing config degrades gracefully: caller treats a false return as non-fatal.
//
// Needs a Twilio account with a WhatsApp-enabled sender (the Twilio Sandbox for
// testing, or an approved WhatsApp Business sender for production) — see
// VERCEL_SETUP.md. Freeform outbound messages only deliver within a 24-hour window
// of the recipient having messaged the sender first; outside that window Twilio
// requires a pre-approved message template instead of arbitrary body text.
async function sendWhatsAppNotification(text) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID
  const authToken = process.env.TWILIO_AUTH_TOKEN
  const from = process.env.TWILIO_WHATSAPP_FROM
  const to = process.env.NOTIFY_WHATSAPP_TO

  if (!accountSid || !authToken || !from || !to) return false

  try {
    const response = await fetch(`${TWILIO_API_BASE}/${accountSid}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({
        From: `whatsapp:${from}`,
        To: `whatsapp:${to}`,
        Body: text
      })
    })

    if (!response.ok) {
      console.error('WhatsApp notification failed:', response.status, await response.text().catch(() => ''))
      return false
    }

    return true
  } catch (error) {
    console.error('WhatsApp notification failed:', error)
    return false
  }
}

module.exports = { sendWhatsAppNotification }
