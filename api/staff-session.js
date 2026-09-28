const { getSession, setSession, clearSession, matchSecret } = require('./_lib/staff-session')

// Sign in / check / sign out for the staff pages. See api/_lib/staff-session.js for why this
// is a cookie.
//
//   GET     -> { ok, role, name } if this phone is signed in, and re-issues the cookie so a
//              phone in regular use never reaches the 180-day expiry. 401 otherwise.
//   POST    -> { password, name } signs in. With a valid session and no password, it just
//              renames (the portal's "who is this" name rides in the cookie).
//   DELETE  -> signs this phone out.
//
// Fails closed: with DASHBOARD_PASSWORD unset nothing can sign in (503), exactly as
// api/tech-auth.js has always behaved.

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
    if (body.length > 4096) return null
  }
  try { return JSON.parse(body || '{}') } catch { return {} }
}

module.exports = async function handler(req, res) {
  if (!process.env.DASHBOARD_PASSWORD) {
    console.error('Staff sign-in refused: DASHBOARD_PASSWORD is not configured')
    return send(res, 503, { ok: false, message: 'Staff sign-in is not set up yet.' })
  }

  if (req.method === 'GET') {
    const session = getSession(req)
    if (!session) return send(res, 401, { ok: false })
    setSession(res, session.role, session.name)
    return send(res, 200, { ok: true, role: session.role, name: session.name })
  }

  if (req.method === 'DELETE') {
    clearSession(res)
    return send(res, 200, { ok: true })
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST, DELETE')
    return send(res, 405, { ok: false })
  }

  const body = await readBody(req)
  if (body === null) return send(res, 413, { ok: false })
  const password = String(body.password || '')
  const name = String(body.name || '').trim().slice(0, 60)

  if (!password) {
    const session = getSession(req)
    if (!session) return send(res, 401, { ok: false, message: 'Wrong password.' })
    setSession(res, session.role, name || session.name)
    return send(res, 200, { ok: true, role: session.role, name: name || session.name })
  }

  const role = matchSecret(password)
  if (!role) return send(res, 401, { ok: false, message: 'Wrong password.' })
  setSession(res, role, name)
  return send(res, 200, { ok: true, role, name })
}
