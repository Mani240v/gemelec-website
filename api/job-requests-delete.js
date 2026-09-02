const { isAuthorized } = require('./_lib/dashboard-auth')
const { getRows, deleteRow } = require('./_lib/sheets')
const { deletePhotos, PREFIX, configured: photoStoreConfigured } = require('./_lib/photo-store')

const SHEET_ID = process.env.JOB_REQUESTS_SHEET_ID
const SHEET_TAB = process.env.JOB_REQUESTS_SHEET_TAB || 'Job Requests'

// Removes a job request outright: the sheet row and the photos that belong to it.
//
// A hard delete, not a status flag. The button exists to get rid of test rows and duplicates,
// and a "deleted" row that still sits in the sheet is exactly the clutter it is meant to
// remove. The trade-off is that this is unrecoverable, which is why the dashboard makes the
// user confirm against the customer's name first.
//
// Photos go with it. Leaving them would keep pictures of somebody's home in storage with no
// record pointing at them and nothing left to purge them — the daily cleaner works on age,
// but nobody would ever look at an orphan again.
function send(res, statusCode, payload) {
  res.statusCode = statusCode
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(payload))
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return send(res, 405, { ok: false, message: 'Method not allowed' })
  }

  if (!isAuthorized(req)) {
    return send(res, 401, { ok: false, message: 'Unauthorized' })
  }

  let raw = ''
  try {
    for await (const chunk of req) {
      raw += chunk
      if (raw.length > 4096) return send(res, 413, { ok: false, message: 'Too large' })
    }
  } catch {
    return send(res, 400, { ok: false, message: 'Could not read the request' })
  }

  let requestId
  try {
    requestId = String(JSON.parse(raw || '{}').request_id || '').trim()
  } catch {
    return send(res, 400, { ok: false, message: 'Could not read the request' })
  }

  if (!requestId) return send(res, 400, { ok: false, message: 'Missing request_id' })

  try {
    // Resolved fresh, never from a row number the browser was holding. Deleting a row shifts
    // every row beneath it up by one, so a stale index deletes the wrong customer's job.
    const { rows } = await getRows(SHEET_ID, SHEET_TAB)
    const match = rows.find(row => row.values.request_id === requestId)

    if (!match) {
      // Already gone. Reported as success so a double-tap on a slow connection does not read
      // as a failure and invite a third press.
      return send(res, 200, { ok: true, alreadyGone: true })
    }

    // Photos first. If the row went first and this failed, the pictures would be orphaned
    // with nothing left in the sheet naming them; this way a failure here leaves the job
    // intact and the delete can simply be pressed again.
    const pathnames = String(match.values.photo_links || '')
      .split(',')
      .map(s => s.trim())
      .filter(p => p.startsWith(PREFIX))

    if (pathnames.length && photoStoreConfigured()) {
      try {
        await deletePhotos(pathnames)
      } catch (error) {
        // Not fatal. An expiring photo left behind is untidy; a job the office cannot get
        // rid of is worse, and the daily purge will collect it within the retention window.
        console.error('Photo delete failed, continuing with row delete:', error)
      }
    }

    await deleteRow(SHEET_ID, SHEET_TAB, match.rowNumber)
    console.log(`Deleted job request ${requestId} (row ${match.rowNumber}, ${pathnames.length} photo(s))`)

    return send(res, 200, { ok: true })
  } catch (error) {
    console.error('Job request delete failed:', error)
    return send(res, 500, { ok: false, message: 'Could not delete that job request.' })
  }
}
