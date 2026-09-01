const crypto = require('node:crypto')
const { getAccessToken } = require('./google-auth')

const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive'

// Some Drive failures are about THIS photo; others are about the configuration and will
// therefore be identical for every remaining photo in the same submission. Retrying the
// second kind is not resilience — each attempt ships the whole multi-megabyte image to
// Google before the rejection comes back, so five photos burn ~8s of a 60s invocation on
// a result that could not have differed. That time is taken straight out of the AI
// costing budget downstream, which is how a known-broken Drive config turned into a
// missing estimate on 2026-09-01.
//
// storageQuotaExceeded is the live example: a bare service account has no Drive of its
// own, so every upload fails until the folder is moved to a shared drive. Auth and
// missing-folder failures are the same shape. Anything else is treated as per-photo and
// still retried, because a single corrupt image must not suppress the other four.
const PERMANENT_DRIVE_REASONS = new Set([
  'storageQuotaExceeded',
  'notFound',
  'forbidden',
  'insufficientPermissions',
  'authError'
])

function isPermanentDriveFailure(status, payload) {
  if (status === 401 || status === 404) return true
  const errors = payload?.error?.errors
  if (Array.isArray(errors) && errors.some(e => PERMANENT_DRIVE_REASONS.has(e?.reason))) {
    return true
  }
  // The quota rejection arrives as a 403 whose only reliable marker in some responses is
  // the message itself, so match it directly rather than trusting `reason` to be present.
  return status === 403 && /storage quota|do not have storage/i.test(payload?.error?.message || '')
}

class DriveError extends Error {
  constructor(message, permanent) {
    super(message)
    this.name = 'DriveError'
    this.permanent = permanent === true
  }
}

// Hand-rolled multipart/related upload (Drive API v3) — no googleapis dependency,
// consistent with the rest of this repo's zero-npm-dep convention. base64Data is
// the already-base64-encoded photo from the client; Drive accepts a base64 media
// part directly via Content-Transfer-Encoding, so no decode/re-encode round trip
// is needed here.
async function uploadPhotoToDrive(folderId, filename, mimeType, base64Data) {
  const accessToken = await getAccessToken([DRIVE_SCOPE])
  const boundary = `gemelec_${crypto.randomBytes(8).toString('hex')}`

  const body =
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${JSON.stringify({ name: filename, parents: [folderId] })}\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: ${mimeType}\r\n` +
    `Content-Transfer-Encoding: base64\r\n\r\n` +
    `${base64Data}\r\n` +
    `--${boundary}--`

  const uploadResponse = await fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': `multipart/related; boundary=${boundary}`
      },
      body
    }
  )

  const uploadPayload = await uploadResponse.json()

  if (!uploadResponse.ok) {
    throw new DriveError(
      uploadPayload.error?.message || 'Failed to upload photo to Google Drive',
      isPermanentDriveFailure(uploadResponse.status, uploadPayload)
    )
  }

  const fileId = uploadPayload.id

  // Photos need to be link-viewable (not fully private) so the dashboard can render
  // thumbnails without a second authenticated fetch hop. Tradeoff flagged in the plan.
  const permissionResponse = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}/permissions`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ role: 'reader', type: 'anyone' })
    }
  )

  if (!permissionResponse.ok) {
    const permissionPayload = await permissionResponse.json().catch(() => ({}))
    throw new DriveError(
      permissionPayload.error?.message || 'Failed to make uploaded photo viewable',
      isPermanentDriveFailure(permissionResponse.status, permissionPayload)
    )
  }

  return {
    fileId,
    viewUrl: `https://drive.google.com/file/d/${fileId}/view`,
    thumbnailUrl: `https://drive.google.com/thumbnail?id=${fileId}&sz=w1000`
  }
}

module.exports = { uploadPhotoToDrive, DriveError }
