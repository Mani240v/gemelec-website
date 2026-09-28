const { isAuthorized } = require('./_lib/dashboard-auth')
const { getSession, sameOrigin } = require('./_lib/staff-session')
const PRICE_LIST = require('./price-list.json')

// The price book for the line-item picker (js/pricebook-picker.js) on both staff pages, so
// nobody has to type every line item by hand. GET only.
//
// Either staff role may read it: the office cookie or password header (isAuthorized, as for
// the rest of the dashboard) or a tech's cookie, since the field portal uses the picker too.
//
// `price` is the list sell_price, ex GST: the RRP. Never the discounted "your price" the
// dashboard shows beside it. Techs see RRP only, and any discount ("mates rates") is Mani's
// call on the dashboard, applied there, so it has no business in anything a tech can load.
// unit_of_measure is left out: it is an empty string on every row.
//
// Cached privately for five minutes: the list only changes with a deploy, and `private` keeps
// a signed-in answer out of any shared cache.

// "Often added with" and popularity counts, mined from past invoices and committed as data.
// Optional: without the file (or with a broken one) the picker still searches the list and
// just has no suggestions to make.
let mined = {}
try {
  mined = require('./pricebook-companions.json')
} catch {
  mined = {}
}

function plainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

// Built once per instance. Nothing in it varies per request.
const BODY = JSON.stringify({
  ok: true,
  items: PRICE_LIST.map(item => ({
    code: item.item_code,
    description: item.description,
    price: item.sell_price
  })),
  companions: plainObject(mined && mined.companions),
  popular: plainObject(mined && mined.popular)
})

function send(res, statusCode, payload) {
  res.statusCode = statusCode
  res.setHeader('Content-Type', 'application/json')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(payload))
}

module.exports = function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    return send(res, 405, { ok: false, message: 'Method not allowed' })
  }

  const session = sameOrigin(req) ? getSession(req) : null
  if (!session && !isAuthorized(req)) {
    return send(res, 401, { ok: false, message: 'Unauthorized' })
  }

  res.statusCode = 200
  res.setHeader('Content-Type', 'application/json')
  res.setHeader('Cache-Control', 'private, max-age=300')
  res.end(BODY)
}
