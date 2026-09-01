const crypto = require('node:crypto')
const { purgeOldPhotos, configured } = require('./_lib/photo-store')

// Daily cleaner for job photos. Scheduled from vercel.json; see photo-store.js for why the
// retention window is safe (the alert email keeps the photos indefinitely).
//
// Vercel sends "Authorization: Bearer $CRON_SECRET" on scheduled invocations. The route is
// public like every other function here, so without this check anyone who found the URL
// could trigger deletions.
function authorised(req) {
  const secret = process.env.CRON_SECRET
  if (!secret) return false

  const provided = String(req.headers.authorization || '')
  const expected = `Bearer ${secret}`

  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json')

  if (!authorised(req)) {
    // Deliberately not "CRON_SECRET is not set" — that tells an unauthenticated caller how
    // the door is locked. The distinction is in the log below instead.
    if (!process.env.CRON_SECRET) console.error('Photo purge refused: CRON_SECRET is not configured')
    res.statusCode = 401
    return res.end(JSON.stringify({ ok: false }))
  }

  if (!configured()) {
    console.error('Photo purge skipped: BLOB_READ_WRITE_TOKEN is not configured')
    res.statusCode = 200
    return res.end(JSON.stringify({ ok: true, skipped: 'blob-not-configured' }))
  }

  try {
    const result = await purgeOldPhotos()
    console.log(`Photo purge: scanned ${result.scanned}, deleted ${result.deleted}, retention ${result.retentionDays}d`)
    res.statusCode = 200
    return res.end(JSON.stringify({ ok: true, ...result }))
  } catch (error) {
    console.error('Photo purge failed:', error)
    res.statusCode = 500
    return res.end(JSON.stringify({ ok: false }))
  }
}
