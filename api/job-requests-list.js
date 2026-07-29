const { isAuthorized } = require('./_lib/dashboard-auth')
const { getRows } = require('./_lib/sheets')

const SHEET_ID = process.env.JOB_REQUESTS_SHEET_ID
const SHEET_TAB = process.env.JOB_REQUESTS_SHEET_TAB || 'Job Requests'

function send(res, statusCode, payload) {
  res.statusCode = statusCode
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(payload))
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Allow', 'GET, OPTIONS')
    return send(res, 204, {})
  }

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    return send(res, 405, { ok: false, message: 'Method not allowed' })
  }

  if (!isAuthorized(req)) {
    return send(res, 401, { ok: false, message: 'Unauthorized' })
  }

  try {
    const { rows } = await getRows(SHEET_ID, SHEET_TAB)
    const requests = rows
      .map(({ rowNumber, values }) => ({ rowNumber, ...values }))
      .sort((a, b) => (a.submitted_at < b.submitted_at ? 1 : -1))

    return send(res, 200, { ok: true, requests })
  } catch (error) {
    console.error('Job requests list failed:', error)
    return send(res, 500, { ok: false, message: 'Could not load job requests.' })
  }
}
