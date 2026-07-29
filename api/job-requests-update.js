const { isAuthorized } = require('./_lib/dashboard-auth')
const { getRows, updateRowCells } = require('./_lib/sheets')

const SHEET_ID = process.env.JOB_REQUESTS_SHEET_ID
const SHEET_TAB = process.env.JOB_REQUESTS_SHEET_TAB || 'Job Requests'
const EDITABLE_FIELDS = ['ai_draft_costing', 'status', 'notes']

function send(res, statusCode, payload) {
  res.statusCode = statusCode
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(payload))
}

function getBody(req) {
  if (req.body && typeof req.body === 'object') return req.body
  if (typeof req.body === 'string') return JSON.parse(req.body || '{}')

  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', chunk => {
      body += chunk
      if (body.length > 200000) {
        req.destroy()
        reject(new Error('Request body too large'))
      }
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(body || '{}'))
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Allow', 'POST, OPTIONS')
    return send(res, 204, {})
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return send(res, 405, { ok: false, message: 'Method not allowed' })
  }

  if (!isAuthorized(req)) {
    return send(res, 401, { ok: false, message: 'Unauthorized' })
  }

  try {
    const body = await getBody(req)
    const requestId = String(body.request_id || '').trim()

    if (!requestId) {
      return send(res, 400, { ok: false, message: 'Missing request_id' })
    }

    const { headers, rows } = await getRows(SHEET_ID, SHEET_TAB)
    const match = rows.find(row => row.values.request_id === requestId)

    if (!match) {
      return send(res, 404, { ok: false, message: 'Job request not found' })
    }

    const updates = {}
    for (const field of EDITABLE_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(body, field)) {
        updates[field] = String(body[field] ?? '')
      }
    }

    if (!Object.keys(updates).length) {
      return send(res, 400, { ok: false, message: 'Nothing to update' })
    }

    await updateRowCells(SHEET_ID, SHEET_TAB, match.rowNumber, headers, updates)

    return send(res, 200, { ok: true })
  } catch (error) {
    console.error('Job request update failed:', error)
    return send(res, 500, { ok: false, message: 'Could not save changes' })
  }
}
