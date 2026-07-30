const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages'
const MODEL = 'claude-haiku-4-5-20251001'

const SYSTEM_PROMPT = `You are drafting a ROUGH internal cost estimate for a Sydney electrical
contractor (GEMELEC Electrical Services), from a customer's job description and photos. This
draft is reviewed and edited by the licensed electrician before anything is ever sent to the
customer — it is never customer-facing as-is.

Hard rules:
- Only price items that are genuinely in the supplied price list. Reference each by its exact
  item_code and use its exact sell_price. Never invent, estimate, or round a dollar figure that
  isn't in the list.
- If the job likely needs something not covered by the price list, do NOT price it — add it to
  flagged_items instead with a short reason (e.g. "not in price list — price manually").
- If you cannot tell what's needed from the description/photos, say so in "summary" rather than
  guessing at line items.
- For each line item, give "qty" (your best guess) plus "qty_low" and "qty_high" — the smallest
  and largest quantity genuinely plausible given the description/photos. Set qty_low = qty =
  qty_high when the quantity is clear and not in question (e.g. "replace one broken GPO", one
  photo of one fixture). Widen qty_low/qty_high only when the actual scope is genuinely unclear
  from what's supplied — an unmeasured cable run, an uncounted number of points, a switchboard
  whose pole count you can't confirm from the photo. Do not widen out of habit or as a hedge;
  most straightforward jobs should have no spread at all.
- Do not compute or report a total yourself — omit estimate_low/estimate_high entirely, they are
  derived automatically from qty_low/qty_high.
- Respond with ONLY raw JSON matching this exact shape, no markdown fences, no commentary:
{
  "summary": "one or two sentence read of what the job likely involves",
  "line_items": [
    { "item_code": "string", "description": "string", "sell_price": 0, "qty": 1, "qty_low": 1, "qty_high": 1, "note": "string or empty" }
  ],
  "flagged_items": [
    { "description": "string", "reason": "string" }
  ]
}`

async function draftCosting({ description, priceList, photos = [] }) {
  const apiKey = process.env.ANTHROPIC_API_KEY

  if (!apiKey) {
    throw new Error('Missing ANTHROPIC_API_KEY environment variable')
  }

  const content = [
    {
      type: 'text',
      text: `Price list (JSON array of {item_code, description, unit_of_measure, sell_price}):\n${JSON.stringify(priceList)}\n\nCustomer's job description:\n${description}`
    },
    ...photos.map(photo => ({
      type: 'image',
      source: { type: 'base64', media_type: photo.mimeType, data: photo.base64 }
    }))
  ]

  const response = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1500,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content }]
    })
  })

  const payload = await response.json()

  if (!response.ok) {
    throw new Error(payload.error?.message || 'Failed to draft costing via Anthropic API')
  }

  const rawText = payload.content?.[0]?.text || ''
  const parsed = parseModelJson(rawText)

  const lineItems = Array.isArray(parsed.line_items) ? parsed.line_items : []
  const { low, high } = computeEstimateRange(lineItems)

  return {
    summary: parsed.summary || '',
    line_items: lineItems,
    flagged_items: Array.isArray(parsed.flagged_items) ? parsed.flagged_items : [],
    estimate_low: round2(low),
    estimate_high: round2(high)
  }
}

function parseModelJson(rawText) {
  try {
    return JSON.parse(rawText)
  } catch {
    const match = rawText.match(/\{[\s\S]*\}/)
    if (match) {
      try {
        return JSON.parse(match[0])
      } catch {
        // fall through
      }
    }
    throw new Error('Anthropic response was not valid JSON')
  }
}

// The model is asked for qty_low/qty_high per line so a real range is possible; the totals
// are computed here rather than trusted from the model's own arithmetic.
function computeEstimateRange(lineItems) {
  return lineItems.reduce((totals, item) => {
    const price = Number(item.sell_price) || 0
    const qty = Number(item.qty) || 0
    const qtyLow = item.qty_low != null ? Number(item.qty_low) : qty
    const qtyHigh = item.qty_high != null ? Number(item.qty_high) : qty
    totals.low += price * Math.min(qtyLow, qtyHigh)
    totals.high += price * Math.max(qtyLow, qtyHigh)
    return totals
  }, { low: 0, high: 0 })
}

function round2(value) {
  return Math.round(value * 100) / 100
}

module.exports = { draftCosting }
