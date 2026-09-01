const { isAuthorized } = require('./_lib/dashboard-auth')
const { getPhoto } = require('./_lib/photo-store')

// Serves one private job photo to the dashboard.
//
// Job photos are private blobs, so their URLs are not fetchable directly — this is the only
// way the bytes come out, and it is behind the same password as the rest of the dashboard.
// The dashboard fetches through here with the auth header and turns the response into an
// object URL, because an <img src> cannot carry a custom header.
module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Allow', 'GET, OPTIONS')
    res.statusCode = 204
    return res.end()
  }

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    res.statusCode = 405
    return res.end('Method not allowed')
  }

  if (!isAuthorized(req)) {
    res.statusCode = 401
    return res.end('Unauthorized')
  }

  const pathname = new URL(req.url, 'http://localhost').searchParams.get('pathname')
  if (!pathname) {
    res.statusCode = 400
    return res.end('Missing pathname')
  }

  try {
    const result = await getPhoto(pathname)

    // getPhoto returns null for a pathname outside the job-photos prefix as well as for a
    // blob that does not exist. Both are a 404 here on purpose: distinguishing them would
    // confirm which pathnames are real.
    if (!result || result.statusCode !== 200) {
      res.statusCode = 404
      return res.end('Not found')
    }

    res.statusCode = 200
    res.setHeader('Content-Type', result.blob?.contentType || 'image/jpeg')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    // Private, so the shared CDN must not hold a copy — only the browser that authenticated
    // for it may cache it, and only briefly.
    res.setHeader('Cache-Control', 'private, max-age=300')
    // A photo is never markup, but it is user-supplied bytes served from our own origin.
    // CSP that forbids scripts and framing costs nothing and closes the whole class.
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox")

    const body = Buffer.from(await new Response(result.stream).arrayBuffer())
    return res.end(body)
  } catch (error) {
    console.error('Job photo fetch failed:', error)
    res.statusCode = 500
    return res.end('Could not load photo')
  }
}
