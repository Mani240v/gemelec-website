const crypto = require('node:crypto')

// Shared-secret check only — no sessions/JWTs. The dashboard has no user accounts,
// just one password Mani keeps, checked with a constant-time comparison.
function isAuthorized(req) {
  const expected = process.env.DASHBOARD_PASSWORD
  const provided = req.headers['x-dashboard-auth']

  if (!expected || !provided) return false

  const expectedBuf = Buffer.from(expected)
  const providedBuf = Buffer.from(String(provided))

  if (expectedBuf.length !== providedBuf.length) return false

  return crypto.timingSafeEqual(expectedBuf, providedBuf)
}

module.exports = { isAuthorized }
