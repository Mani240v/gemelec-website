const { put, get, list, del } = require('@vercel/blob')

// Job photos live in Vercel Blob rather than Google Drive.
//
// Drive was never made to work: a bare service account has no Drive storage of its own, so
// every upload came back "Service Accounts do not have storage quota" and the fix needed
// either a Workspace shared drive or domain-wide delegation. Owner's call on 2026-09-01 was
// to drop Google for photos entirely and host them on the same platform as the site, with a
// short retention so the bill stays near zero.
//
// Two rules hold this together and both matter:
//
// 1. Everything is written under PREFIX. The purge lists by that prefix and never sees
//    anything else, so a blob some future feature puts in this store cannot be deleted by
//    the photo cleaner. Without the prefix the cleaner is "delete everything older than 14
//    days" against a shared store, which is a footgun waiting for its second user.
// 2. Photos are private. Drive's copy was link-viewable — unlisted, but anyone with the URL
//    could open it, and these are photos of customers' homes and switchboards. Private means
//    the bytes are only reachable through api/job-photo.js, behind the dashboard password.
const PREFIX = 'job-photos/'

// Blob is the convenience copy for the dashboard, not the archive. The alert email carries
// the photos as attachments on every submission and keeps them for as long as the mailbox
// does, which is why deleting here is safe.
const DEFAULT_RETENTION_DAYS = 14

function retentionDays() {
  const raw = Number(process.env.PHOTO_RETENTION_DAYS)
  // Guard the whole shape, not just NaN: a stray 0 or a negative would make the cleaner
  // delete photos the moment they land, and '1e9' would silently disable it.
  if (!Number.isFinite(raw) || raw < 1 || raw > 3650) return DEFAULT_RETENTION_DAYS
  return Math.floor(raw)
}

function configured() {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN)
}

// Uploads one photo and returns its pathname. The pathname, not the URL, is what gets
// stored and passed around: a private blob's URL is not directly fetchable, so a URL in the
// sheet would look like a working link and never be one.
async function putPhoto(requestId, index, mimeType, base64Data) {
  const type = /^image\/(jpeg|jpg|png|webp)$/i.test(String(mimeType || '')) ? mimeType : 'image/jpeg'
  const body = Buffer.from(String(base64Data || ''), 'base64')

  if (!body.length) throw new Error('Photo had no content after base64 decode')

  // addRandomSuffix keeps pathnames unguessable, so knowing a request id does not let
  // someone enumerate that job's photos even if the auth in front of them were ever weakened.
  // It also removes any chance of one submission overwriting another's photo.
  const blob = await put(`${PREFIX}${requestId}-${index + 1}.jpg`, body, {
    access: 'private',
    contentType: type,
    addRandomSuffix: true
  })

  return blob.pathname
}

// Streams one photo back for the dashboard. Callers MUST have authorised the request first —
// this function does no checking of its own.
async function getPhoto(pathname) {
  // Refuse anything outside the photo prefix. Without this the dashboard password would be
  // enough to read every blob in the store by guessing a pathname, including blobs belonging
  // to any future feature that shares it.
  if (typeof pathname !== 'string' || !pathname.startsWith(PREFIX) || pathname.includes('..')) {
    return null
  }
  return get(pathname, { access: 'private' })
}

// Deletes photos older than the retention window. Returns what it did so the cron endpoint
// can log a real number rather than "done".
async function purgeOldPhotos(now = Date.now()) {
  const days = retentionDays()
  const cutoff = now - days * 24 * 60 * 60 * 1000
  const doomed = []
  let scanned = 0
  let cursor

  do {
    const page = await list({ prefix: PREFIX, cursor, limit: 1000 })
    for (const blob of page.blobs) {
      scanned += 1
      const uploadedAt = new Date(blob.uploadedAt).getTime()
      // An unparseable date is left alone. Treating it as old would delete on bad data,
      // and the cost of keeping one extra photo is a fraction of a cent.
      if (Number.isFinite(uploadedAt) && uploadedAt < cutoff) doomed.push(blob.pathname)
    }
    cursor = page.hasMore ? page.cursor : undefined
  } while (cursor)

  // del takes an array, but not an unbounded one — chunk it so a big backlog on the first
  // run cannot fail the whole purge in one oversized request.
  for (let i = 0; i < doomed.length; i += 100) {
    await del(doomed.slice(i, i + 100))
  }

  return { scanned, deleted: doomed.length, retentionDays: days }
}

// Deletes specific photos, for when a whole job is removed rather than aged out. Scoped to
// the prefix like everything else here, so a pathname from a corrupted row cannot be used to
// delete something outside the photo store.
async function deletePhotos(pathnames) {
  const safe = (Array.isArray(pathnames) ? pathnames : [])
    .filter(p => typeof p === 'string' && p.startsWith(PREFIX) && !p.includes('..'))
  if (!safe.length) return { deleted: 0 }
  await del(safe)
  return { deleted: safe.length }
}

module.exports = { putPhoto, getPhoto, purgeOldPhotos, deletePhotos, configured, PREFIX, retentionDays }
