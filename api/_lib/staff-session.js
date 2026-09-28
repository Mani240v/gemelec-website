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
// Token: v1.<expiry>.<role>.<name as base64url>.<HMAC-SHA256>.
//
// The HMAC key is keyed by a long server-only secret AND mixed with the current staff
// passwords. Both halves matter:
//   - The secret: a key made from the passwords alone turns every cookie into an offline
//     password checker. Anyone holding one (a subcontractor on TECH_ACCESS_CODE reading
//     their own cookie, or whoever finds a lost phone) could guess DASHBOARD_PASSWORD at GPU
//     speed with no rate limit. With a secret the server never reveals, a cookie says
//     nothing about the password.
//   - The passwords: changing DASHBOARD_PASSWORD or TECH_ACCESS_CODE changes the key, so
//     every phone is signed out. That's the lost-phone lever.
// The secret is STAFF_SESSION_SECRET if set (32+ random characters), otherwise the Google
// service account's private key, which every deployment already has for the Sheets pipeline
// and which is long, random and never leaves the server. Rotating whichever one is used
// also signs everyone out.
// GET /api/staff-session re-issues the cookie, so a phone in regular use never expires.

const COOKIE = 'gx_staff'
const MAX_AGE_S = 180 * 24 * 60 * 60
const ROLES = ['office', 'tech']

function signingKey() {
  const office = process.env.DASHBOARD_PASSWORD
  // A STAFF_SESSION_SECRET that's too short is ignored rather than obeyed: obeying it would
  // 503 every staff endpoint and lock Mani out of the dashboard over one mistyped setting.
  const custom = process.env.STAFF_SESSION_SECRET
  if (custom && custom.length < 32) {
    console.error('STAFF_SESSION_SECRET is shorter than 32 characters; ignoring it and signing with GOOGLE_PRIVATE_KEY')
  }
  const secret = custom && custom.length >= 32 ? custom : process.env.GOOGLE_PRIVATE_KEY
  // Fail closed: without a password to check or a secret to sign with, no session can be
  // issued or accepted.
  if (!office || !secret || secret.length < 32) return null
  return crypto
    .createHmac('sha256', secret)
    .update(JSON.stringify(['gemelec-staff-session-v1', office, process.env.TECH_ACCESS_CODE || '']))
    .digest()
}

// Can sessions be issued at all? The endpoints answer 503 rather than a false "ok" if not.
function sessionsConfigured() {
  return signingKey() !== null
}

// A short fingerprint of the current credentials, for things that must stop working when the
// password changes but can't carry the cookie themselves. Push subscriptions store it, so
// changing the password (the lost-phone lever) also stops a lost phone's notifications.
function credentialTag() {
  const key = signingKey()
  return key ? crypto.createHmac('sha256', key).update('push-subscriptions').digest('hex').slice(0, 16) : null
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

// The cookie is only trusted on the site's own requests. SameSite=Strict already keeps other
// sites out; this also refuses same-site origins that aren't this one (the apex, any other
// *.gemelec.com.au host), now that an ambient cookie can reach the delete/update endpoints
// where the custom header used to force a CORS preflight. Browsers too old to send
// Sec-Fetch-Site are let through, as they were before.
function sameOrigin(req) {
  const site = req.headers['sec-fetch-site']
  return !site || site === 'same-origin'
}

module.exports = { getSession, setSession, clearSession, matchSecret, sessionsConfigured, sameOrigin, credentialTag }
