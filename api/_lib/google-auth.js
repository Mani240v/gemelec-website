const crypto = require('node:crypto')

function base64url(value) {
  return Buffer.from(value)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
}

function signJwt(serviceAccountEmail, privateKey, scopes) {
  const now = Math.floor(Date.now() / 1000)
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const claim = base64url(JSON.stringify({
    iss: serviceAccountEmail,
    scope: scopes.join(' '),
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now
  }))
  const unsigned = `${header}.${claim}`
  const signer = crypto.createSign('RSA-SHA256')
  signer.update(unsigned)
  signer.end()
  return `${unsigned}.${signer.sign(privateKey, 'base64url')}`
}

async function getAccessToken(scopes) {
  const serviceAccountEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL
  const privateKey = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n')

  if (!serviceAccountEmail || !privateKey) {
    throw new Error('Missing Google service account environment variables')
  }

  const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: signJwt(serviceAccountEmail, privateKey, scopes)
    })
  })

  const tokenPayload = await tokenResponse.json()

  if (!tokenResponse.ok) {
    throw new Error(tokenPayload.error_description || tokenPayload.error || 'Failed to authorize with Google')
  }

  return tokenPayload.access_token
}

module.exports = { base64url, signJwt, getAccessToken }
