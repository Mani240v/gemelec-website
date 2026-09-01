const crypto = require('node:crypto')

// Access check for the field portal at /tech.
//
// Defaults to DASHBOARD_PASSWORD. Mani's call on 2026-09-01: his techs have the authority
// to see pricing, so there is nothing to wall off between the portal and the dashboard, and
// one secret is one thing for staff to remember and one env var not to get wrong.
//
// TECH_ACCESS_CODE overrides it when set. That exists for the day a subcontractor needs to
// submit jobs without being handed the pricing dashboard — setting it splits the two with
// no code change.
//
// Either way this gate is obscurity plus accountability, not a security boundary:
// /api/job-request is public by necessity (it is the customer form), so anyone determined
// can already post a job request without any of this. What the code buys is that a customer
// cannot stumble onto the staff page, and that submissions carry a name.
function timingSafeEquals(a, b) {
  const bufA = Buffer.from(String(a))
  const bufB = Buffer.from(String(b))
  if (bufA.length !== bufB.length) return false
  return crypto.timingSafeEqual(bufA, bufB)
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json')

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    res.statusCode = 405
    return res.end(JSON.stringify({ ok: false }))
  }

  const expected = process.env.TECH_ACCESS_CODE || process.env.DASHBOARD_PASSWORD

  // Fail closed. An unset code must lock the door, never open it — the opposite would mean
  // forgetting one env var silently publishes the staff portal.
  if (!expected) {
    console.error('Tech portal auth refused: neither TECH_ACCESS_CODE nor DASHBOARD_PASSWORD is configured')
    res.statusCode = 503
    return res.end(JSON.stringify({ ok: false, message: 'Field portal is not set up yet.' }))
  }

  let body = ''
  for await (const chunk of req) {
    body += chunk
    if (body.length > 4096) {
      res.statusCode = 413
      return res.end(JSON.stringify({ ok: false }))
    }
  }

  let provided = ''
  try {
    provided = JSON.parse(body || '{}').code || ''
  } catch {
    provided = ''
  }

  if (!timingSafeEquals(provided, expected)) {
    res.statusCode = 401
    return res.end(JSON.stringify({ ok: false, message: 'Wrong code.' }))
  }

  res.statusCode = 200
  return res.end(JSON.stringify({ ok: true }))
}
