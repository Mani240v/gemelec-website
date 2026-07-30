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
- Respond with ONLY raw JSON matching this exact shape, no markdown fences, no commentary:
{
  "summary": "one or two sentence read of what the job likely involves",
  "line_items": [
    { "item_code": "string", "description": "string", "sell_price": 0, "qty": 1, "note": "string or empty" }
  ],
  "flagged_items": [
    { "description": "string", "reason": "string" }
  ],
  "uncertainty_pct": 0
}
uncertainty_pct reflects how much the final price could realistically grow past the sum of
line_items, based on labour-time variability, scope not fully visible in photos, hidden wiring/
access issues, or ambiguity about which item/tier actually applies (e.g. which switchboard
upgrade size) — NOT a made-up number. Pick honestly:
- 0 only for a genuinely flat-rate, fixed-scope callout with no variability (e.g. a single
  like-for-like safety switch swap).
- 0.15-0.25 for a typical job where the parts are clear but labour time could reasonably vary.
- 0.3-0.5 when photos don't show the full scope, access/wiring condition is unknown, the item/tier
  is ambiguous, or the description is vague about quantity/extent.
Do not compute a dollar range yourself — the app derives estimate_low/estimate_high from
line_items and uncertainty_pct.`

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
  const base = lineItems.reduce((sum, item) => sum + (Number(item.qty) || 0) * (Number(item.sell_price) || 0), 0)
  const uncertaintyPct = Math.min(Math.max(Number(parsed.uncertainty_pct) || 0, 0), 0.75)

  return {
    summary: parsed.summary || '',
    line_items: lineItems,
    flagged_items: Array.isArray(parsed.flagged_items) ? parsed.flagged_items : [],
    estimate_low: round2(base),
    estimate_high: round2(base * (1 + uncertaintyPct))
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

function round2(value) {
  return Math.round(value * 100) / 100
}

module.exports = { draftCosting }
