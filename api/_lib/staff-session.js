const crypto = require('node:crypto')

// "Remember this phone" for the two staff pages, /tech and /job-requests.
//
// Until 2026-09-29 the dashboard kept its password in sessionStorage, so every new tab asked
// again, including every "Review:" link in a lead alert. And iPhone Safari wipes a site's
// localStorage after about a week without a visit, so the portal forgot its code too. Mani:
// "im so over inputting it". A signed cookie fixes both. The server sets it once the code is
// right, and it is:
//   - HttpOnly: no script on the site can read it. The stored password always could, and
//     the public pages load third-party scripts (GA4, the Swiper CDN) on the same origin.
//   - Secure + SameSite=Strict: only ever sent on the site's own HTTPS requests, so another
//     site can't ride it into the update/delete endpoints.
//   - Server-set: Safari's 7-day purge applies to script-written storage, not to this.
//
// Token: v1.<expiry>.<role>.<name as base64url>.<HMAC-SHA256>. The key is derived from the
// current staff passwords, so changing DASHBOARD_PASSWORD or TECH_ACCESS_CODE signs every
// phone out. That is deliberate: rotating the password is how a lost phone is locked out.
// GET /api/staff-session re-issues the cookie, so a phone in regular use never expires.

const COOKIE = 'gx_staff'
const MAX_AGE_S = 180 * 24 * 60 * 60
const ROLES = ['office', 'tech']

function signingKey() {
  const office = process.env.DASHBOARD_PASSWORD
  // Fail closed: with no password configured there is nothing to sign with, so no session
  // can be issued or accepted.
  if (!office) return null
  return crypto
    .createHash('sha256')
    .update(`gemelec-staff-session|${office}|${process.env.TECH_ACCESS_CODE || ''}`)
    .digest()
}

function sign(payload, key) {
  return crypto.createHmac('sha256', key).update(payload).digest('base64url')
}

function timingSafeEquals(a, b) {
  const bufA = Buffer.from(String(a))
  const bufB = Buffer.from(String(b))
  if (bufA.length !== bufB.length) return false
  return crypto.timingSafeEqual(bufA, bufB)
}

// Which staff secret the provided value is, if any: 'office' for DASHBOARD_PASSWORD (full
// dashboard access, as before), 'tech' for a separate TECH_ACCESS_CODE (portal only).
function matchSecret(provided) {
  const office = process.env.DASHBOARD_PASSWORD
  const tech = process.env.TECH_ACCESS_CODE
  if (office && timingSafeEquals(provided, office)) return 'office'
  if (tech && timingSafeEquals(provided, tech)) return 'tech'
  return null
}

function readCookie(req, name) {
  const header = req.headers.cookie || ''
  for (const part of header.split(';')) {
    const i = part.indexOf('=')
    if (i === -1) continue
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim()
  }
  return ''
}

// The signed-in staff member, or null. Never throws.
function getSession(req) {
  const key = signingKey()
  if (!key) return null
  const parts = readCookie(req, COOKIE).split('.')
  if (parts.length !== 5 || parts[0] !== 'v1') return null
  if (!timingSafeEquals(parts[4], sign(parts.slice(0, 4).join('.'), key))) return null

  const exp = Number(parts[1])
  if (!Number.isFinite(exp) || exp * 1000 < Date.now()) return null
  const role = parts[2]
  if (!ROLES.includes(role)) return null

  let name = ''
  try { name = Buffer.from(parts[3], 'base64url').toString('utf8') } catch { name = '' }
  return { role, name }
}

function cookie(value, maxAge) {
  return `${COOKIE}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Strict`
}

// Returns false (and sets nothing) when no password is configured.
function setSession(res, role, name) {
  const key = signingKey()
  if (!key || !ROLES.includes(role)) return false
  const exp = Math.floor(Date.now() / 1000) + MAX_AGE_S
  const nameB64 = Buffer.from(String(name || '').trim().slice(0, 60), 'utf8').toString('base64url')
  const payload = `v1.${exp}.${role}.${nameB64}`
  res.setHeader('Set-Cookie', cookie(`${payload}.${sign(payload, key)}`, MAX_AGE_S))
  return true
}

function clearSession(res) {
  res.setHeader('Set-Cookie', cookie('', 0))
}

module.exports = { getSession, setSession, clearSession, matchSecret }
