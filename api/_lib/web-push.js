const crypto = require('node:crypto')
const { put, get, list, del } = require('@vercel/blob')

// Push notifications to staff devices for new website enquiries (added 2026-09-29).
//
// Before this the only prompt was the alert email, and it went out after the AI costing, up
// to a minute later. Mani: "i seem to get to them late as its only on my email". (The
// WhatsApp alert in api/_lib/whatsapp.js was never switched on: no TWILIO_* vars exist.)
//
// This is standard Web Push, implemented on node:crypto rather than the web-push package,
// in line with the repo's dependency budget (CLAUDE.md):
//   - VAPID (RFC 8292): an ES256-signed JWT tells the push service the sender is us.
//   - aes128gcm (RFC 8291): the payload is end-to-end encrypted to the device, so Apple,
//     Google and Mozilla carry a customer's name and job snippet without being able to read it.
//
// The VAPID key pair is derived from the same server-only secret as the staff cookie, with
// its own label, so there is no extra env var to set. Rotating that secret changes the keys,
// which silently invalidates every subscription; js/staff-push.js notices the public key has
// changed and resubscribes the next time the page is opened.
//
// Subscriptions live in the private Blob store under PREFIX, one JSON file per device,
// named by a hash of the endpoint so re-subscribing overwrites rather than duplicates. The
// photo purge only ever lists job-photos/, so it can't touch these.

const PREFIX = 'push-subs/'
const SUB_PATHNAME_RE = /^push-subs\/[a-f0-9]{64}\.json$/
const P256_ORDER = BigInt('0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551')

// Only the real browser push services. The endpoint comes from the browser, but the server
// POSTs to it, so without this a signed-in user could point the server at any URL.
const PUSH_HOST_RE = /^(fcm\.googleapis\.com|updates\.push\.services\.mozilla\.com|[a-z0-9-]+\.push\.services\.mozilla\.com|web\.push\.apple\.com|[a-z0-9-]+\.push\.apple\.com|[a-z0-9-]+\.notify\.windows\.com)$/

function b64url(buf) {
  return Buffer.from(buf).toString('base64url')
}

// Same choice as api/_lib/staff-session.js: a long server-only secret.
function serverSecret() {
  const custom = process.env.STAFF_SESSION_SECRET
  const secret = custom && custom.length >= 32 ? custom : process.env.GOOGLE_PRIVATE_KEY
  return secret && secret.length >= 32 ? secret : null
}

let cachedKeys = null
function vapidKeys() {
  const secret = serverSecret()
  if (!secret) return null
  if (cachedKeys && cachedKeys.secret === secret) return cachedKeys
  // A P-256 private key is any integer in [1, n-1]; take an HMAC of the secret into that range.
  const h = crypto.createHmac('sha256', secret).update('gemelec-vapid-v1').digest('hex')
  const d = (BigInt('0x' + h) % (P256_ORDER - 1n)) + 1n
  const dBuf = Buffer.from(d.toString(16).padStart(64, '0'), 'hex')
  const ecdh = crypto.createECDH('prime256v1')
  ecdh.setPrivateKey(dBuf)
  const pub = ecdh.getPublicKey() // 65 bytes, uncompressed point
  const privateKey = crypto.createPrivateKey({
    key: { kty: 'EC', crv: 'P-256', d: b64url(dBuf), x: b64url(pub.subarray(1, 33)), y: b64url(pub.subarray(33, 65)) },
    format: 'jwk'
  })
  cachedKeys = { secret, publicKey: b64url(pub), privateKey }
  return cachedKeys
}

function publicKey() {
  const keys = vapidKeys()
  return keys ? keys.publicKey : null
}

function vapidAuthorization(endpoint, keys) {
  const header = b64url(JSON.stringify({ typ: 'JWT', alg: 'ES256' }))
  const claims = b64url(JSON.stringify({
    aud: new URL(endpoint).origin,
    exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
    sub: 'mailto:info@gemelec.sydney'
  }))
  const unsigned = `${header}.${claims}`
  // ES256 JWTs carry the raw r||s signature, not DER, hence ieee-p1363.
  const signature = crypto.sign('sha256', Buffer.from(unsigned), { key: keys.privateKey, dsaEncoding: 'ieee-p1363' })
  return `vapid t=${unsigned}.${b64url(signature)}, k=${keys.publicKey}`
}

// RFC 8291 aes128gcm: one record, with the sender's ephemeral public key as the key id.
function encryptPayload(payload, keys) {
  const uaPublic = Buffer.from(keys.p256dh, 'base64url')
  const authSecret = Buffer.from(keys.auth, 'base64url')
  const ecdh = crypto.createECDH('prime256v1')
  ecdh.generateKeys()
  const asPublic = ecdh.getPublicKey()
  const sharedSecret = ecdh.computeSecret(uaPublic)

  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic])
  const ikm = Buffer.from(crypto.hkdfSync('sha256', sharedSecret, authSecret, keyInfo, 32))
  const salt = crypto.randomBytes(16)
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16))
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12))

  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce)
  // 0x02 marks the last (and only) record; no padding beyond it.
  const plaintext = Buffer.concat([Buffer.from(payload, 'utf8'), Buffer.from([2])])
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()])

  const header = Buffer.alloc(21)
  salt.copy(header, 0)
  header.writeUInt32BE(4096, 16) // record size
  header.writeUInt8(asPublic.length, 20) // key id length (65)
  return Buffer.concat([header, asPublic, ciphertext])
}

function validEndpoint(endpoint) {
  if (typeof endpoint !== 'string') return false
  let url
  try { url = new URL(endpoint) } catch { return false }
  return url.protocol === 'https:' && PUSH_HOST_RE.test(url.hostname)
}

// A browser PushSubscription.toJSON(), checked before anything is stored or posted to.
function validSubscription(sub) {
  if (!sub || typeof sub !== 'object' || !validEndpoint(sub.endpoint)) return false
  const keys = sub.keys || {}
  try {
    return Buffer.from(String(keys.p256dh || ''), 'base64url').length === 65 &&
      Buffer.from(String(keys.auth || ''), 'base64url').length === 16
  } catch {
    return false
  }
}

function pathnameFor(endpoint) {
  return `${PREFIX}${crypto.createHash('sha256').update(endpoint).digest('hex')}.json`
}

async function saveSubscription(sub, name) {
  const record = {
    endpoint: sub.endpoint,
    keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
    name: String(name || '').slice(0, 60),
    savedAt: new Date().toISOString()
  }
  await put(pathnameFor(sub.endpoint), JSON.stringify(record), {
    access: 'private',
    contentType: 'application/json',
    addRandomSuffix: false,
    allowOverwrite: true
  })
}

async function removeSubscription(endpoint) {
  await del(pathnameFor(endpoint))
}

async function readSubscription(pathname) {
  if (!SUB_PATHNAME_RE.test(pathname)) return null
  const result = await get(pathname, { access: 'private' })
  if (!result || result.statusCode !== 200) return null
  try { return JSON.parse(await new Response(result.stream).text()) } catch { return null }
}

// One device. Returns the push service's status (201 is success).
async function sendOne(sub, payload, keys = vapidKeys()) {
  if (!keys) throw new Error('Push is not configured: no server secret')
  const response = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      Authorization: vapidAuthorization(sub.endpoint, keys),
      TTL: '86400',
      Urgency: 'high',
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream'
    },
    body: encryptPayload(JSON.stringify(payload), sub.keys)
  })
  return response.status
}

// Every subscribed device. Never throws: this runs after the customer has their answer, and
// a notification failure must not disturb the rest of the job-request work. A device the
// push service reports as gone (404/410) is removed, which is how uninstalled apps and
// revoked permissions get cleaned up.
async function notifyAll(payload) {
  const keys = vapidKeys()
  if (!keys || !process.env.BLOB_READ_WRITE_TOKEN) return { sent: 0, failed: 0 }
  let sent = 0
  let failed = 0
  try {
    const pathnames = []
    let cursor
    do {
      const page = await list({ prefix: PREFIX, cursor, limit: 1000 })
      page.blobs.forEach(blob => pathnames.push(blob.pathname))
      cursor = page.hasMore ? page.cursor : undefined
    } while (cursor)

    await Promise.all(pathnames.map(async pathname => {
      try {
        const sub = await readSubscription(pathname)
        if (!sub || !validSubscription(sub)) return
        const status = await sendOne(sub, payload, keys)
        if (status >= 200 && status < 300) {
          sent += 1
        } else {
          failed += 1
          if (status === 404 || status === 410) await del(pathname)
          else console.error(`Push to ${new URL(sub.endpoint).hostname} failed with ${status}`)
        }
      } catch (error) {
        failed += 1
        console.error('Push send failed:', error.message)
      }
    }))
  } catch (error) {
    console.error('Push notify failed:', error.message)
  }
  return { sent, failed }
}

module.exports = { publicKey, validEndpoint, validSubscription, saveSubscription, removeSubscription, sendOne, notifyAll }
