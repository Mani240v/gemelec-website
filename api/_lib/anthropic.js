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
  "estimate_low": 0,
  "estimate_high": 0
}
estimate_low/estimate_high are simply the sum of line_items (qty * sell_price), given as a range
only if quantity or scope is uncertain from the description — otherwise low and high can match.`

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

module.exports = { draftCosting }
