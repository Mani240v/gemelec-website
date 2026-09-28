const crypto = require('node:crypto')
const { getSession } = require('./staff-session')

// One password Mani keeps, no user accounts. A request is let in by either:
//   - the signed staff cookie from api/_lib/staff-session.js with the 'office' role (how the
//     dashboard and portal authenticate since 2026-09-29, so nobody retypes it per tab), or
//   - the password itself in the X-Dashboard-Auth header, checked in constant time. Kept so
//     a page still open from before the cookie existed keeps working until it reloads.
function isAuthorized(req) {
  const session = getSession(req)
  if (session && session.role === 'office') return true

  const expected = process.env.DASHBOARD_PASSWORD
  const provided = req.headers['x-dashboard-auth']

  if (!expected || !provided) return false

  const expectedBuf = Buffer.from(expected)
  const providedBuf = Buffer.from(String(provided))

  if (expectedBuf.length !== providedBuf.length) return false

  return crypto.timingSafeEqual(expectedBuf, providedBuf)
}

module.exports = { isAuthorized }
