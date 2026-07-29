const crypto = require('node:crypto')
const { appendRow } = require('./_lib/sheets')

const HEADERS = [
  'submitted_at',
  'lead_id',
  'source',
  'form_name',
  'page_url',
  'landing_page',
  'referrer',
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'full_name',
  'phone',
  'email',
  'suburb',
  'service_required',
  'urgency',
  'property_type',
  'company_name',
  'job_address',
  'preferred_contact_method',
  'preferred_timeframe',
  'message',
  'status',
  'notes'
]

const DEFAULT_SHEET_ID = '1E5So0KBv8geIEahMrw3qaZGzjDll2pDrugjGikwei4c'
const DEFAULT_SHEET_TAB = 'Web Leads'

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
      if (body.length > 100000) {
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

function clean(value, maxLength = 1000) {
  return String(value || '').trim().slice(0, maxLength)
}

async function appendLead(row) {
  const sheetId = process.env.GOOGLE_SHEET_ID || DEFAULT_SHEET_ID
  const sheetTab = process.env.GOOGLE_SHEET_TAB || DEFAULT_SHEET_TAB
  return appendRow(sheetId, sheetTab, HEADERS, row)
}

async function notifyLeadWebhook(row) {
  const webhookUrl = process.env.N8N_LEAD_WEBHOOK_URL

  if (!webhookUrl) return false

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(row)
    })

    if (!response.ok) {
      console.error('Lead webhook returned non-ok status:', response.status)
      return false
    }

    return true
  } catch (error) {
    console.error('Lead webhook notify failed:', error)
    return false
  }
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

  try {
    const body = await getBody(req)

    if (clean(body.company_website)) {
      return send(res, 200, { ok: true })
    }

    const requiredFields = ['full_name', 'phone', 'suburb', 'service_required']
    const missingFields = requiredFields.filter(field => !clean(body[field]))

    if (missingFields.length) {
      return send(res, 400, {
        ok: false,
        message: 'Please complete the required fields before sending.',
        missingFields
      })
    }

    const row = {
      submitted_at: new Date().toISOString(),
      lead_id: `web-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`,
      source: clean(body.source) || 'website',
      form_name: clean(body.form_name) || 'quote-form',
      page_url: clean(body.page_url, 2000),
      landing_page: clean(body.landing_page, 500),
      referrer: clean(body.referrer, 2000),
      utm_source: clean(body.utm_source, 250),
      utm_medium: clean(body.utm_medium, 250),
      utm_campaign: clean(body.utm_campaign, 250),
      utm_term: clean(body.utm_term, 250),
      utm_content: clean(body.utm_content, 250),
      full_name: clean(body.full_name || body.name, 250),
      phone: clean(body.phone, 100),
      email: clean(body.email, 250),
      suburb: clean(body.suburb, 250),
      service_required: clean(body.service_required || body.service, 250),
      urgency: clean(body.urgency, 250),
      property_type: clean(body.property_type, 250),
      company_name: clean(body.company_name, 250),
      job_address: clean(body.job_address, 500),
      preferred_contact_method: clean(body.preferred_contact_method, 250),
      preferred_timeframe: clean(body.preferred_timeframe, 250),
      message: clean(body.message, 3000),
      status: 'new',
      notes: ''
    }

    const sheetSaved = await appendLead(row)
      .then(() => true)
      .catch(error => {
        console.error('Lead sheet append failed:', error)
        return false
      })

    const webhookSent = await notifyLeadWebhook(row)

    if (!sheetSaved && !webhookSent) {
      console.error('Lead not captured by any destination:', row.lead_id)
      return send(res, 500, {
        ok: false,
        message: 'Sorry, the enquiry could not be sent. Please call 0498 351 351.'
      })
    }

    return send(res, 200, {
      ok: true,
      leadId: row.lead_id,
      message: 'Thanks - we will be in touch within 2 hours during business hours.'
    })
  } catch (error) {
    console.error('Lead submit failed:', error)
    return send(res, 500, {
      ok: false,
      message: 'Sorry, the enquiry could not be sent. Please call 0498 351 351.'
    })
  }
}
