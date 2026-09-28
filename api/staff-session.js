const { getSession, setSession, clearSession, matchSecret, sessionsConfigured, sameOrigin } = require('./_lib/staff-session')

// Sign in / check / sign out for the staff pages. See api/_lib/staff-session.js for why this
// is a cookie.
//
//   GET     -> { ok, role, name } if this phone is signed in, and re-issues the cookie so a
//              phone in regular use never reaches the 180-day expiry. 401 otherwise.
//   POST    -> { password, name?, scope? } signs in. A sign-in without a name keeps the name
//              already on the cookie, so signing in on the dashboard doesn't wipe the tech
//              name the portal needs. scope: 'office' (sent by the dashboard) refuses a tech
//              code outright instead of swapping this device's office cookie for a tech one.
//              With a valid session and no password, it just renames.
//   DELETE  -> signs this phone out (both pages: they share the cookie).
//
// Fails closed with a 503 when sessions can't be signed: DASHBOARD_PASSWORD unset, or no
// server secret (STAFF_SESSION_SECRET / GOOGLE_PRIVATE_KEY). Note this is stricter than the
// old api/tech-auth.js, which worked with TECH_ACCESS_CODE alone; DASHBOARD_PASSWORD is now
// required even for a portal-only setup, because it is part of the signing key.

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
  if (!sessionsConfigured()) {
    console.error('Staff sign-in refused: DASHBOARD_PASSWORD or the session signing secret is not configured')
    return send(res, 503, { ok: false, message: 'Staff sign-in is not set up yet.' })
  }

  if (req.method === 'GET') {
    const session = sameOrigin(req) ? getSession(req) : null
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
  const current = sameOrigin(req) ? getSession(req) : null

  if (!password) {
    if (!current) return send(res, 401, { ok: false, message: 'Wrong password.' })
    const renamed = name || current.name
    setSession(res, current.role, renamed)
    return send(res, 200, { ok: true, role: current.role, name: renamed })
  }

  const role = matchSecret(password)
  if (!role) return send(res, 401, { ok: false, message: 'Wrong password.' })
  if (body.scope === 'office' && role !== 'office') {
    return send(res, 401, { ok: false, message: 'That is the field-portal code. This page needs the office password.' })
  }
  const keptName = name || (current && current.name) || ''
  setSession(res, role, keptName)
  return send(res, 200, { ok: true, role, name: keptName })
}
