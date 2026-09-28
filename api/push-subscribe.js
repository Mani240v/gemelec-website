const { isAuthorized } = require('./_lib/dashboard-auth')
const { getSession, sameOrigin } = require('./_lib/staff-session')
const { publicKey, validEndpoint, validSubscription, saveSubscription, removeSubscription, sendOne } = require('./_lib/web-push')

// Sign a staff device up for (or off) new-enquiry notifications. See api/_lib/web-push.js.
//
//   GET                         -> { ok, publicKey } for PushManager.subscribe
//   POST { subscription }       -> store this device
//   POST { subscription, test } -> send this one device a test notification
//   DELETE { endpoint }         -> forget this device
//
// Office sign-in only (the staff cookie, or the old header): these notifications carry
// customer names, which is the same information the dashboard itself guards.

function send(res, statusCode, payload) {
  res.statusCode = statusCode
  res.setHeader('Content-Type', 'application/json')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(payload))
}

// Same shape as getBody in api/job-request.js: Vercel may already have parsed it.
async function readBody(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body || '{}') } catch { return {} }
  }
  let body = ''
  for await (const chunk of req) {
    body += chunk
    if (body.length > 8192) return null
  }
  try { return JSON.parse(body || '{}') } catch { return {} }
}

module.exports = async function handler(req, res) {
  if (!isAuthorized(req)) return send(res, 401, { ok: false, message: 'Sign in with the office password first.' })

  const key = publicKey()
  if (!key) return send(res, 503, { ok: false, message: 'Notifications are not set up yet.' })
  if (!process.env.BLOB_READ_WRITE_TOKEN) return send(res, 503, { ok: false, message: 'Notifications are not set up yet.' })

  if (req.method === 'GET') return send(res, 200, { ok: true, publicKey: key })

  const body = await readBody(req)
  if (body === null) return send(res, 413, { ok: false })

  if (req.method === 'DELETE') {
    if (!validEndpoint(body.endpoint)) return send(res, 400, { ok: false })
    try { await removeSubscription(body.endpoint) } catch (error) { console.error('Push unsubscribe failed:', error.message) }
    return send(res, 200, { ok: true })
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST, DELETE')
    return send(res, 405, { ok: false })
  }

  const sub = body.subscription
  if (!validSubscription(sub)) return send(res, 400, { ok: false, message: 'That device sent an unusable subscription.' })

  try {
    if (body.test) {
      let status
      try {
        status = await sendOne(sub, {
          title: 'Notifications are on',
          body: "This is a test. You'll get one like this for every website enquiry.",
          url: '/job-requests',
          tag: 'gemelec-test'
        })
      } catch (error) {
        console.error('Push test send failed:', error.message)
        return send(res, 502, { ok: false, message: "Couldn't reach the notification service. Try the test again in a moment." })
      }
      if (status < 200 || status >= 300) {
        console.error(`Push test to ${new URL(sub.endpoint).hostname} failed with ${status}`)
        return send(res, 502, { ok: false, message: `The notification service refused it (${status}). Try turning notifications off and on again.` })
      }
      return send(res, 200, { ok: true })
    }
    const session = sameOrigin(req) ? getSession(req) : null
    await saveSubscription(sub, session ? session.name : '')
    return send(res, 200, { ok: true })
  } catch (error) {
    console.error('Push subscribe failed:', error.message)
    return send(res, 500, { ok: false, message: 'Could not save that. Try again in a moment.' })
  }
}
