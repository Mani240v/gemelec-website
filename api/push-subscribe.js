const { isAuthorized } = require('./_lib/dashboard-auth')
const { getSession, sameOrigin } = require('./_lib/staff-session')
const { publicKey, validEndpoint, validSubscription, saveSubscription, removeSubscription, sendOne, listStatus } = require('./_lib/web-push')

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

  const session = sameOrigin(req) ? getSession(req) : null
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
      if (status === 404 || status === 410) {
        // The push service has dropped this device's sign-up (browsers reset them after site
        // data is cleared or the permission is toggled). Forget it here; js/staff-push.js
        // signs the device up again and retries once on seeing `gone`.
        console.error(`Push test to ${new URL(sub.endpoint).hostname} got ${status}: subscription gone`)
        await removeSubscription(sub.endpoint).catch(() => {})
        return send(res, 410, { ok: false, gone: true, message: "This device's notification sign-up had expired." })
      }
      if (status < 200 || status >= 300) {
        console.error(`Push test to ${new URL(sub.endpoint).hostname} failed with ${status}`)
        return send(res, 502, { ok: false, message: `The notification service refused it (${status}). Try turning notifications off and on again.` })
      }
      // The test went straight to the subscription this device handed over, but a real
      // enquiry goes to the saved list (notifyAll), so a passing test used to say nothing
      // about whether the next enquiry reaches this device (added 2026-09-29, after one
      // didn't). Check the list now, and put the device back if it's off it. Done after the
      // send, so Blob can't delay the push while js/staff-push.js's arrival timer runs, and
      // capped at five seconds. `list` is reported only from what actually happened:
      //   listed               already on it
      //   relisted-missing     wasn't on it; enquiries since it dropped off missed it
      //   relisted-signed-out  on it under an old password, which the next enquiry would
      //                        have deleted (one already sent would have, so none were missed)
      //   not-listed           off it and couldn't be put back
      //   unknown              couldn't check in time
      let listed = 'unknown'
      let list = 'unknown'
      const check = (async () => {
        listed = await listStatus(sub.endpoint)
        if (listed === 'listed') {
          list = 'listed'
          return
        }
        list = 'not-listed'
        await saveSubscription(sub, session ? session.name : '')
        list = listed === 'signed-out' ? 'relisted-signed-out' : 'relisted-missing'
      })()
      let timer
      let timedOut = false
      try {
        await Promise.race([
          check,
          new Promise((resolve, reject) => {
            timer = setTimeout(() => { timedOut = true; reject(new Error('timed out after 5s')) }, 5000)
          })
        ])
      } catch (error) {
        console.error('Push test list check failed:', error.message)
      } finally {
        clearTimeout(timer)
      }
      check.catch(() => {})
      // A save still running at the deadline may yet land, so that is "unknown", not "not-listed".
      if (timedOut) list = 'unknown'
      console.log(`Push test to ${new URL(sub.endpoint).hostname}: device was ${listed}, now ${list}`)
      return send(res, 200, { ok: true, list })
    }
    await saveSubscription(sub, session ? session.name : '')
    return send(res, 200, { ok: true })
  } catch (error) {
    console.error('Push subscribe failed:', error.message)
    return send(res, 500, { ok: false, message: 'Could not save that. Try again in a moment.' })
  }
}
