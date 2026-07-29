const crypto = require('node:crypto')
const { getAccessToken } = require('./google-auth')

const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive'

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
    throw new Error(uploadPayload.error?.message || 'Failed to upload photo to Google Drive')
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
    throw new Error(permissionPayload.error?.message || 'Failed to make uploaded photo viewable')
  }

  return {
    fileId,
    viewUrl: `https://drive.google.com/file/d/${fileId}/view`,
    thumbnailUrl: `https://drive.google.com/thumbnail?id=${fileId}&sz=w1000`
  }
}

module.exports = { uploadPhotoToDrive }
