const { isAuthorized } = require('./_lib/dashboard-auth')
const { generateQuoteDescription } = require('./_lib/quote-description')

// Writes the quote scope description for one job, on demand from the dashboard.
//
// On demand rather than with every estimate: most enquiries never become a quote, and this is
// a second Opus call per job. Mani presses the button on the ones he is actually quoting.
const FUNCTION_BUDGET_MS = 55000

function send(res, statusCode, payload) {
  res.statusCode = statusCode
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(payload))
}

module.exports = async function handler(req, res) {
  const startedAt = Date.now()

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
      // Line items plus a description; a megabyte of it is not a real request.
      if (raw.length > 200000) return send(res, 413, { ok: false, message: 'Too large' })
    }
  } catch {
    return send(res, 400, { ok: false, message: 'Could not read the request' })
  }

  let body
  try {
    body = JSON.parse(raw || '{}')
  } catch {
    return send(res, 400, { ok: false, message: 'Could not read the request' })
  }

  try {
    const result = await generateQuoteDescription({
      // The CURRENT table, sent by the dashboard — not the stored draft. Mani edits lines
      // before quoting, and the customer must be told what he settled on, not what the
      // estimator first guessed.
      lineItems: body.line_items,
      customerDescription: body.description,
      budgetMs: FUNCTION_BUDGET_MS - (Date.now() - startedAt)
    })
    return send(res, 200, { ok: true, description: result.description })
  } catch (error) {
    console.error('Quote description failed:', error)
    // kind is set on CostingError and is safe to surface: it says which step failed, never
    // anything about the key or the account.
    const message = error?.kind === 'no_items'
      ? 'Add at least one line item before generating a description.'
      : 'Could not generate a description. Try again.'
    return send(res, error?.kind === 'no_items' ? 400 : 502, { ok: false, message })
  }
}
