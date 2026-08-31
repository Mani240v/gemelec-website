// The trust boundary between the model and money.
//
// The model never gets a field to put a dollar figure in. It returns an item_code and a
// qty; every price, every canonical description and every sum in the system is read from
// api/price-list.json here. A fabricated price is not detected and corrected — it is
// unrepresentable, because nothing downstream reads a number the model wrote.
//
// Quantity is the one number the model still supplies, so it is where the remaining risk
// sits. price-list.json cannot help: unit_of_measure is an empty string on all 207 rows,
// so nothing in the data says whether $250 for SB-REPLACE-PP is a job or a pole, or
// whether $165 for LABOUR is an hour or a visit. The UNITS table below is hand-authored
// for exactly that reason. It is Mani's call to correct, not the model's to guess.

const PRICE_LIST = require('../price-list.json')

// Exact-string lookup only. 13 codes are strict prefixes of another code (across 10
// distinct prefixes: TANDT -> TANDTESTAB is $7.50 vs $250, a 33x error; SBOARD-UPG-24P ->
// SBOARD-UPG-24P+ is a $1,760 delta; L2 "Labour 2 x Tradesman" -> L2-ASP-WORKS, and in NSW
// trade language "Level 2" means an Accredited Service Provider, so the wrong one is the
// intuitive pick). Three more pairs collide once punctuation is stripped. So: no trim, no
// whitespace collapse, no separator stripping, no prefix or nearest-match repair — any
// "helpful" resolution silently buys a differently-priced row. 11 codes contain legitimate
// internal spaces, which is why trimming would itself be a corruption.
const BY_CODE = new Map(PRICE_LIST.map(item => [item.item_code, item]))
// Case-folded side index only, resolved back to the canonical stored string. Codes are
// unique under case folding; two contain lowercase (SMOKE-WIRED W/L Interconnect,
// Travel / Callout).
const BY_FOLDED = new Map(PRICE_LIST.map(item => [item.item_code.toLowerCase(), item]))
const ALL_CODES = PRICE_LIST.map(item => item.item_code)

const DEFAULT_QTY_MAX = 12
const LINE_VALUE_CAP = 15000
const SUBTOTAL_CAP = 30000
const MAX_LINES = 25

// Hand-authored quantity semantics. `unit` is printed in the catalogue the model reads;
// `max` is enforced here regardless of what the model was told. 20 codes carry a -PM
// suffix; the rest are per-unit rates with NO suffix, invisible to any regex over the
// code or the description, so they are enumerated by hand.
const UNITS = {
  // Per-metre rates (-PM suffix)
  '1.5-LTS-CCT-RUN-PM': { unit: 'PER METRE', max: 60 },
  '10-PWR-RUN-PM': { unit: 'PER METRE', max: 60 },
  '16-XLPE-PM': { unit: 'PER METRE', max: 60 },
  '2.5-4C+E-PWR-CCT-RUN-PM': { unit: 'PER METRE', max: 60 },
  '2.5-PWR-CCT-RUN-PM': { unit: 'PER METRE', max: 60 },
  '4-PWR-RUN-PM': { unit: 'PER METRE', max: 60 },
  '6-PWR-RUN-PM': { unit: 'PER METRE', max: 60 },
  'BRICK-CHASE-CONDUIT-PM': { unit: 'PER METRE', max: 60 },
  'BUSBAR-RUN-PM': { unit: 'PER METRE', max: 40 },
  'CABLE-TRAY-RUN-PM': { unit: 'PER METRE', max: 60 },
  'CAT6-CABLE-RUN-PM': { unit: 'PER METRE', max: 60 },
  'CCTV-CABLE-RUN-PM': { unit: 'PER METRE', max: 60 },
  'EV-CCT-RUN-PM': { unit: 'PER METRE', max: 60 },
  'HDMI-RUN-PM': { unit: 'PER METRE', max: 60 },
  'MAINS-UPG-1P-PM': { unit: 'PER METRE', max: 60 },
  'MAINS-UPG-3P-PM': { unit: 'PER METRE', max: 60 },
  'STRIP-LIGHT-PM': { unit: 'PER METRE', max: 40 },
  'STRUT-CHANNEL-PM': { unit: 'PER METRE', max: 60 },
  'SUBMAIN-RUN-PM': { unit: 'PER METRE', max: 60 },
  'TRACK-RAIL-PM': { unit: 'PER METRE', max: 40 },

  // Per-unit rates with NO -PM suffix. No regex finds these.
  'SB-REPLACE-PP': {
    unit: 'PER POLE',
    max: 32,
    means: 'qty = the number of poles. For a whole-board upgrade use a SBOARD-UPG-* tier instead — never both.'
  },
  'AWNING-2': {
    unit: 'PER AWNING',
    max: 6,
    means: 'Use only when there is more than one awning, and set qty to the TOTAL number of awnings. Never combine with AWNING-1.'
  },
  'L2-ASP-WORKS': { unit: 'PER HOUR', max: 16 },
  'PATCH-PANEL-FULL': { unit: 'PER PANEL', max: 6 },
  'PATCH-PANEL-PORT': { unit: 'PER PORT', max: 48 },
  CABREP: { unit: 'PER CORE', max: 8 },
  'RCD-TEST-BOARD': { unit: 'PER BOARD', max: 4 },
  'RCD-TEST-EACH': { unit: 'PER RCD', max: 30 },
  'SMOKE-COMPLIANCE-CHECK': { unit: 'PER ALARM', max: 30 },
  TANDT: { unit: 'PER ITEM', max: 200 },

  // Inverse traps: fixed multi-unit bundles whose descriptions mention metres exactly
  // like the genuine per-metre rates do. A metre-count qty here overcharges 4-5x.
  '25/20-CONDUIT+FIXINGS': {
    unit: 'PER 4 METRES',
    max: 15,
    means: 'One unit is a 4 metre length. A 20 m run is qty 5, NOT qty 20.'
  },
  '32/40 CONDUIT+FIXINGS': {
    unit: 'PER 4 METRES',
    max: 15,
    means: 'One unit is a 4 metre length. A 20 m run is qty 5, NOT qty 20.'
  },
  LED5M: {
    unit: 'PER 5 METRES',
    max: 10,
    means: 'One unit is a 5 metre strip. A 10 m run is qty 2, NOT qty 10.'
  },

  // Labour. Only L2-ASP-WORKS states a time basis anywhere in the file, so for the rest
  // we genuinely do not know whether $165 buys an hour, a visit or a day. Capped low and
  // flagged whenever qty > 1 — at qty 1 the ambiguity costs nothing, above it we are
  // multiplying an unknown unit.
  LABOUR: { unit: 'TIME BASIS NOT RECORDED', max: 8 },
  '2LAB': { unit: 'TIME BASIS NOT RECORDED', max: 8 },
  'T+A': { unit: 'TIME BASIS NOT RECORDED', max: 8 },
  L2: { unit: 'TIME BASIS NOT RECORDED', max: 8 },
  LAH: { unit: 'TIME BASIS NOT RECORDED', max: 8 },
  SUBC: { unit: 'TIME BASIS NOT RECORDED', max: 8 },

  // One per job.
  'SBOARD-UPG-12P': { unit: 'flat, one per board', max: 1 },
  'SBOARD-UPG-24P': { unit: 'flat, one per board', max: 1 },
  'SBOARD-UPG-24P+': { unit: 'flat, one per board', max: 1 },
  'CCTV-KIT-4': { unit: 'flat, one complete kit', max: 1 },
  'CCTV-KIT-8': { unit: 'flat, one complete kit', max: 1 },
  'CCTV-KIT-16': { unit: 'flat, one complete kit', max: 1 },
  'Travel / Callout': { unit: 'flat, one per visit', max: 1 },
  'AWNING-1': { unit: 'flat, one awning only', max: 1 },
  '2.5-PWR-RUN <5M': { unit: 'flat, one circuit', max: 2 },
  '2.5-PWR-RUN >5M': { unit: 'flat, one circuit', max: 2 },
  '2.5-PWR-RUN 10/20M': { unit: 'flat, one circuit', max: 2 },
  '2.5-PWR-RUN 20/30M': { unit: 'flat, one circuit', max: 2 }
}

const LABOUR_CODES = new Set(['LABOUR', '2LAB', 'T+A', 'L2', 'LAH', 'SUBC'])

// Families whose own data contradicts itself. FAMILIES is shown to the model, in front of
// the decision, so it can avoid the mistake; AMBIGUOUS fires afterwards so Mani sees the
// same warning on anything that was picked from one of them anyway. Prevention and
// enforcement, not one or the other.
const FAMILIES = [
  {
    heading: '2.5mm circuit runs — choose EXACTLY ONE of these five',
    codes: ['2.5-PWR-RUN <5M', '2.5-PWR-RUN >5M', '2.5-PWR-RUN 10/20M', '2.5-PWR-RUN 20/30M', '2.5-PWR-CCT-RUN-PM'],
    note: 'This family is internally inconsistent: a >5 m run is priced BELOW a <5 m run, and the codes and descriptions disagree on the 10/20M and 20/30M bands. Do not try to resolve it. Price the run with 2.5-PWR-CCT-RUN-PM and qty = the estimated metres, and put a line in unpriced_items saying the flat-rate tier for this length needs Mani to confirm it.'
  },
  {
    heading: 'Switchboard replacement — a flat upgrade tier OR per pole, never both',
    codes: ['SBOARD-UPG-12P', 'SBOARD-UPG-24P', 'SBOARD-UPG-24P+', 'SB-REPLACE-PP'],
    note: 'Prefer the flat SBOARD-UPG-* tier that matches the pole count. SB-REPLACE-PP is a PER POLE rate: at qty 1 it reads as a $250 board replacement, a 21x undercount on a 24-pole board.'
  },
  {
    heading: 'Fitting an RCBO or safety switch — six overlapping options, $241 to $560',
    codes: ['SAFETY-SWITCH-ADD', 'RCBO-REPLACE', 'RCBO-FAULT', 'SBOARD-INS-RCBO', 'RCD/RCBO', '3PHCB'],
    note: 'These overlap heavily. Choose on what the job actually is: adding a new standalone RCD to an existing board, swapping a faulty RCBO like-for-like, fault-finding then fitting, or converting a CB/fuse to an RCBO. If the description does not distinguish them, pick the closest, say which reading you used in "why", and name the alternative.'
  },
  {
    heading: 'Wireless-interconnect smoke alarms — three overlapping options',
    codes: ['SMOKE-WIRED', 'SMOKE-WIRED W/L Interconnect', 'W/L SMOKEY'],
    note: 'SMOKE-WIRED W/L Interconnect ($480) and W/L SMOKEY ($610) are both wireless-interconnect alarms; on a six-alarm house the wrong pick is a $780 error. SMOKE-WIRED is WIRED interconnect, which is different work. Say in "why" which distinction you relied on.'
  },
  {
    heading: 'Downlight installation',
    codes: ['DL-INSTALL<12'],
    note: 'The code says under 12 but the description says "more than 12". It is a volume discount, so the DESCRIPTION governs: use this only for 12 or more downlights.'
  },
  {
    heading: 'Garden spike lighting',
    codes: ['GRDN-KIT-1', 'GRDN-KIT-2'],
    note: 'GRDN-KIT-2 reads "<10-20", which is not a parseable range, and it is dearer than GRDN-KIT-1 (>10 lights), which inverts the expected volume curve. If garden lighting is in scope, put it in unpriced_items for Mani rather than picking a kit.'
  },
  {
    heading: 'Awnings',
    codes: ['AWNING-1', 'AWNING-2'],
    note: 'One awning: AWNING-1 at qty 1. Two or more: AWNING-2 with qty = the total count. Never AWNING-1 plus AWNING-2.'
  },
  {
    heading: 'LED strip lighting',
    codes: ['LED5M', 'STRIP-LIGHT-PM'],
    note: 'Two defensible prices for identical work — a 5 m bundle or a per-metre rate. Pick one and say why. Never both.'
  },
  {
    heading: 'RCD testing',
    codes: ['RCD-TEST-BOARD', 'RCD-TEST-EACH'],
    note: 'Per board or per RCD, never both for the same board.'
  },
  {
    heading: 'Switchboard thermal testing',
    codes: ['BOARD-THERMAL-TEST', 'THERMO-SCAN-BOARD'],
    note: 'These look like the same job at the same $185. Pick either, never both.'
  },
  {
    heading: 'Labour and callout',
    codes: ['LABOUR', '2LAB', 'T+A', 'L2', 'LAH', 'SUBC', 'L2-ASP-WORKS', 'Travel / Callout'],
    note: 'Only L2-ASP-WORKS states a time basis ("Per Hour"). For the rest the price list does not record whether the rate is per hour, per visit or per day, so keep qty at 1 unless the job clearly needs more, and say in "why" which reading you used. L2 is "Labour 2 x Tradesman" — it is NOT Level 2 / ASP work, which is L2-ASP-WORKS.'
  }
]

// The same work priced two ways. If more than one member appears, both lines are KEPT
// (deleting one risks deleting the right one) and the overlap is flagged for Mani.
//
// Labour is excluded for the same reason AMBIGUOUS excludes it, and the family's own note
// says so: a callout fee PLUS labour is the correct, ordinary shape of a Sydney call-out
// job, not the same work counted twice. Left in, this fired a red "keep whichever one
// applies" warning — advice that is simply wrong — on most jobs the business does.
const MUTEX_SETS = FAMILIES
  .filter(family => family.codes.length > 1 && !family.heading.startsWith('Labour'))
  .map(family => ({ label: family.heading.split(' — ')[0].toLowerCase(), codes: family.codes }))

// Shown to Mani whenever a line was drawn from a self-contradictory family. A Map, not an
// object literal, so a lookup can never fall through to Object.prototype.
const AMBIGUOUS = new Map()
for (const family of FAMILIES) {
  if (family.heading.startsWith('Labour')) continue // labour has its own, narrower flag
  for (const code of family.codes) AMBIGUOUS.set(code, family.note)
}

// A Map on purpose. `confidence` is a string the model supplies, and on a plain object
// literal every Object.prototype key — 'constructor', '__proto__', 'toString', 'valueOf',
// 'hasOwnProperty', 'isPrototypeOf' — resolves to a truthy inherited value whose .down and
// .up are undefined. The `|| low` guard never fires, and subtotal * (1 - undefined) is NaN:
// a $780 job rendered as "$0.00" on the dashboard with ai_status 'ok' and nothing flagged.
// Map.get returns undefined for all of them, so the fallback works.
const CONFIDENCE_BAND = new Map([
  ['high', { down: 0.10, up: 0.15 }],
  ['medium', { down: 0.20, up: 0.35 }],
  ['low', { down: 0.35, up: 0.60 }]
])
const WIDEST_BAND = CONFIDENCE_BAND.get('low')

// Mani's standing discount off list. The price list is the worst case, not the usual
// charge, so every line carries both figures: the list price as the ceiling and this as
// what he normally quotes. Change this one number to change the whole site's discount.
const DISCOUNT_PCT = 0.30

// A percentage put on the model's own confidence, decided HERE rather than asked of the
// model. A model that reports "40% confident" is inventing a calibrated-looking number it
// has no way to calibrate, which is the same false precision this module exists to stop.
// These are fixed labels for the three states the model can actually distinguish, so the
// same job always reads the same way and Mani owns what each one means.
const CONFIDENCE_PCT = new Map([
  ['high', 85],
  ['medium', 60],
  ['low', 35]
])
// Anything the server had to reject, clamp or flag drops confidence to this regardless of
// what the model claimed, matching the band override below.
const OVERRIDDEN_CONFIDENCE_PCT = 35

// Drift guard. The tables above are hand-maintained against business data Mani owns and
// edits, and this repo has no build or test step to catch a mismatch. This WARNS rather
// than throws on purpose: price-book is required transitively by api/job-request.js, so a
// module-load throw here would 500 the lead-capture form the moment Mani renamed one of
// his own items — turning a stale annotation into lost business. A code that has gone
// missing simply loses its annotation and prices as "flat", which is the safe default.
;(function checkAnnotationDrift() {
  const referenced = new Set([
    ...Object.keys(UNITS),
    ...LABOUR_CODES,
    ...FAMILIES.flatMap(family => family.codes)
  ])
  const missing = [...referenced].filter(code => !BY_CODE.has(code))
  if (missing.length) {
    console.warn(
      'price-book: these annotated item codes are no longer in price-list.json and their ' +
      'quantity limits and notes will not apply — update api/_lib/price-book.js: ' +
      missing.join(', ')
    )
  }
})()

// Rendered once at module load and never re-derived — byte stability is what keeps the
// prompt cache alive, so nothing in here may vary per request. TSV rather than JSON:
// JSON.stringify(priceList) is 26,795 bytes, of which roughly 4,500 is
// `"unit_of_measure":""` repeated 207 times — waste that also reads to the model as
// "this item has no unit", which is the opposite of what we want it thinking.
const CATALOGUE_TEXT = (() => {
  const lines = []
  const emitted = new Set()

  const renderItem = code => {
    const item = BY_CODE.get(code)
    if (!item) return
    const annotation = UNITS[code]
    const out = [`${item.item_code}\t${item.sell_price.toFixed(2)}\t${annotation?.unit || 'flat'}\t${item.description}`]
    if (annotation?.means) out.push(`    qty: ${annotation.means}`)
    lines.push(out.join('\n'))
    emitted.add(code)
  }

  lines.push('GEMELEC price list. These 207 items are the complete set you may choose from, and')
  lines.push('these prices are the real ones. You do not need to repeat a price back — the')
  lines.push('application reads every price from this list itself.')
  lines.push('')
  lines.push('Columns are TAB separated: item_code / sell_price / unit / description.')
  lines.push('The unit column is Mani\'s own annotation, not part of the price list — the list')
  lines.push('does not record its own units. "flat" means one unit is the whole job. Read the')
  lines.push('unit before you set a quantity: getting the unit wrong is the most expensive')
  lines.push('mistake available to you, and far worse than saying you are unsure.')
  lines.push('')
  lines.push('== Items where the same work can be priced more than one way ==')
  lines.push('Lines marked !! are Mani\'s ruling on a known problem in his own price list. They')
  lines.push('override your own judgement about which item fits.')
  lines.push('')

  for (const family of FAMILIES) {
    lines.push(`### ${family.heading}`)
    for (const code of family.codes) renderItem(code)
    lines.push(`    !! ${family.note}`)
    lines.push('')
  }

  lines.push('== Everything else ==')
  for (const item of PRICE_LIST) {
    if (!emitted.has(item.item_code)) renderItem(item.item_code)
  }

  return lines.join('\n')
})()

// Rejection reasons travel on the error so api/job-request.js can record them in the
// sheet's ai_status column. A bare "failed" tells nobody anything a week later.
function rejectDraft(message, status) {
  const error = new Error(message)
  error.aiStatus = `failed:${status}`
  error.kind = status
  return error
}

// The system prompt tells the model that any price it writes in prose is ignored. This is
// the line that makes that true rather than merely requested, and it lives here because
// this is the module that owns the money boundary. Every field it is applied to is
// steerable by the customer's description — public-form input — and they all render beside
// the server's own canonical figures with nothing marking which is which. Nothing is lost:
// Mani sees the customer's own words verbatim in the job description block on the same
// card, which is where such a claim belongs and is already labelled as the customer
// talking.
const MONEY_PATTERN = /(?:A?\$|€|£)\s?\d[\d,]*(?:\.\d+)?|\b\d[\d,]*(?:\.\d+)?\s?(?:dollars|AUD|USD)\b/gi

function stripPrices(value) {
  if (typeof value !== 'string') return ''
  return value.replace(MONEY_PATTERN, '[amount removed]')
}

function round2(value) {
  return Math.round(value * 100) / 100
}

function money(value) {
  return Number(value).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

// Exact match only, with a case-folded fallback that resolves back to the canonical
// stored string. Never repairs, never guesses, never returns a near miss.
function resolveCode(raw) {
  if (typeof raw !== 'string' || !raw) return null
  return BY_CODE.get(raw) || BY_FOLDED.get(raw.toLowerCase()) || null
}

// Turns the model's selections into priced line items. Every price and every description
// comes from price-list.json; the model's own values are never operands.
//
// Throws when the result is not safe to show as a number at all — on any doubt the
// pipeline writes no estimate rather than a wrong one, and Mani gets the blank editable
// table he already gets today whenever the AI step fails.
function priceSelections(selections, confidence) {
  const lineItems = []
  const flagged = []
  const notes = []
  const byCode = new Map()
  const flagKeys = new Set()
  const noteKeys = new Set()
  let clamped = 0
  let rejected = 0

  // Two channels, deliberately separate.
  //
  // flagged_items is "something went wrong with this draft and it needs checking" — a
  // clamp, a rejection, a duplicate, a genuine double-count. It is the channel that widens
  // the dollar band and colours the dashboard block red.
  //
  // notes is "Mani's own ruling about his own price list applied here" — useful, but
  // routine and not a fault. 29 of the 207 codes carry one, including every switchboard
  // tier, every RCD/RCBO and every smoke alarm, so routing these through flagged_items
  // meant the red block fired on nearly every common job with nothing actionable in it,
  // AND forced the widest band: an exact $5,280 flat-rate switchboard upgrade was
  // broadcast as "$3,432.00 - $8,448.00", a floor 35% under Mani's own list price.
  //
  // Both are deduped: without it, 30 repeated lines produce 25 identical warnings and the
  // block stops being read.
  const addFlag = (description, reason) => {
    const key = `${description}|||${reason}`
    if (flagKeys.has(key)) return
    flagKeys.add(key)
    flagged.push({ description, reason })
  }

  const addNote = (description, reason) => {
    const key = `${description}|||${reason}`
    if (noteKeys.has(key)) return
    noteKeys.add(key)
    notes.push({ description, reason })
  }

  const label = item => `${item.item_code} — ${item.description}`

  const input = Array.isArray(selections) ? selections.slice(0, MAX_LINES) : []
  if (Array.isArray(selections) && selections.length > MAX_LINES) {
    rejected += selections.length - MAX_LINES
    addFlag(
      `${selections.length} line items were proposed`,
      `only the first ${MAX_LINES} were priced and the rest were dropped — price this one manually.`
    )
  }

  for (const selection of input) {
    if (!selection || typeof selection !== 'object' || Array.isArray(selection)) {
      rejected += 1
      addFlag('Unreadable line item', 'the AI returned something that was not an item — price this manually.')
      continue
    }

    // A fabricated or fallback-model-invented code dies here, whatever the schema did.
    const item = resolveCode(selection.item_code)
    if (!item) {
      rejected += 1
      addFlag(
        stripPrices(String(selection.why || selection.item_code || 'unnamed item')).slice(0, 200),
        `no such item code in the price list (${JSON.stringify(String(selection.item_code)).slice(0, 60)}) — nothing was priced for this, add it manually.`
      )
      continue
    }

    // Strict number test. Never `Number(x) || 0`, which passes negatives, Infinity and
    // the string '1e9' straight through. An unusable quantity drops the line rather than
    // defaulting to 1 — a real priced line for garbage input is worse than no line.
    //
    // Number.isInteger, not Math.round. Rounding silently turned qty 1.5 into 2 — a 33%
    // over-count with no flag and a clean 'ok' status — and rounded 0.6 up to a full
    // $12,800 CCTV kit from a quantity the model itself signalled as partial. It also made
    // the policy inconsistent: 0.4 was dropped and flagged while 0.6 was priced silently.
    // A fraction is exactly as unusable as a string, so it is treated the same way.
    const rawQty = selection.qty
    if (!Number.isInteger(rawQty) || rawQty < 1) {
      rejected += 1
      addFlag(label(item), 'the AI did not give a usable whole-number quantity, so nothing was priced for this line — add it manually.')
      continue
    }
    const qty = rawQty

    const existing = byCode.get(item.item_code)
    if (existing) {
      // Merge first, clamp afterwards. Clamping inside this loop leaves an obvious
      // bypass: 30 separate lines of LABOUR at qty 1 each would sum straight past a
      // ceiling of 8, because no single line ever breaches it.
      existing.qty += qty
      addFlag(label(item), 'the AI listed this item more than once and the quantities were added together — check that is right.')
      continue
    }

    // description and sell_price come from the file. The model supplied neither.
    const line = {
      item_code: item.item_code,
      description: item.description,
      qty,
      sell_price: item.sell_price,
      // Derived, never model-supplied, and never an operand — the totals below are built
      // from sell_price and discounted independently, so a rounded line can't drift the
      // total. Recomputed live in the dashboard whenever Mani edits a price.
      discounted_price: round2(item.sell_price * (1 - DISCOUNT_PCT))
    }
    byCode.set(item.item_code, line)
    lineItems.push(line)
  }

  for (const line of lineItems) {
    const item = BY_CODE.get(line.item_code)
    const annotation = UNITS[line.item_code]
    const codeMax = annotation?.max ?? DEFAULT_QTY_MAX

    if (line.qty > codeMax) {
      line.qty = codeMax
      clamped += 1
      addFlag(
        label(item),
        `the quantity was cut back to the most this system will price without review (${codeMax}) — check the real count.`
      )
    }

    if (line.qty * line.sell_price > LINE_VALUE_CAP) {
      const fitted = Math.floor(LINE_VALUE_CAP / line.sell_price)
      if (fitted < 1) {
        // Only reachable if a single unit of one item exceeds the cap, which no row in
        // the current price list does. A future price edit that crossed it would be a
        // genuine impossibility rather than something to clamp.
        throw rejectDraft(`Line item above the per-line ceiling at qty 1: ${line.item_code}`, 'line-cap')
      }
      line.qty = fitted
      clamped += 1
      addFlag(
        label(item),
        `the quantity was cut back to keep this line under $${money(LINE_VALUE_CAP)} — check the real count.`
      )
    }

    if (LABOUR_CODES.has(line.item_code) && line.qty > 1) {
      addFlag(
        label(item),
        'labour: the price list does not record whether this rate is per hour, per visit or per day, so multiplying it is a guess — set the real time yourself.'
      )
    }

    if (annotation?.means && line.qty > 1) {
      addFlag(label(item), `${annotation.unit.toLowerCase()} — ${annotation.means}`)
    }

    if (AMBIGUOUS.has(line.item_code)) {
      addNote(label(item), AMBIGUOUS.get(line.item_code))
    }
  }

  for (const set of MUTEX_SETS) {
    const hits = set.codes.filter(code => byCode.has(code))
    if (hits.length > 1) {
      addFlag(
        hits.join(' + '),
        `these ${set.label} items overlap, so the same work may be counted twice — keep whichever one applies.`
      )
    }
  }

  const subtotal = round2(lineItems.reduce((sum, line) => sum + line.qty * line.sell_price, 0))

  // The write gate: no NUMBER leaves here unless it survives this. It withholds the
  // estimate rather than throwing the draft away, which is what it used to do — and the
  // draft it threw away contained no model-supplied figures at all. Every code had already
  // been matched against price-list.json and every price read out of it, so a commercial
  // job at $32,076 lost four correct line items, the reasoning and the flags, and the
  // dashboard then reported it as "No AI draft available" — a cap misread as a model
  // failure, on the largest job the system will ever see, where a starting itemisation is
  // worth the most. Blanking the estimate alone satisfies "on any doubt, write no number".
  const overCap = !Number.isFinite(subtotal) || subtotal < 0 || subtotal > SUBTOTAL_CAP
  if (overCap) {
    addFlag(
      'Total is above the ceiling this system will price',
      `the items below add up to more than $${money(SUBTOTAL_CAP)}, so no estimate range was worked out — the itemisation is the AI's picks priced from your list, but total it yourself.`
    )
  }

  // The model proposes a confidence; the server decides it. Anything rejected, clamped or
  // flagged forces the widest band regardless of what the model claimed. `notes` are
  // deliberately NOT in that test — see addNote above.
  let band = CONFIDENCE_BAND.get(confidence) || WIDEST_BAND
  let confidencePct = CONFIDENCE_PCT.get(confidence) ?? OVERRIDDEN_CONFIDENCE_PCT
  if (clamped || rejected || flagged.length) {
    band = WIDEST_BAND
    confidencePct = OVERRIDDEN_CONFIDENCE_PCT
  }

  const showRange = lineItems.length > 0 && !overCap

  return {
    line_items: lineItems,
    flagged_items: flagged,
    notes,
    over_cap: overCap,
    subtotal: overCap ? null : subtotal,
    // estimate_low gets a real downside. Price error is now zero by construction, so the
    // whole band expresses selection error — and an untrusted selector over-picks as
    // readily as it under-picks, so the low end has to move too. null, not 0, when there
    // is no range to show: "$0.00" reads like a genuine no-charge job.
    estimate_low: showRange ? round2(subtotal * (1 - band.down)) : null,
    estimate_high: showRange ? round2(subtotal * (1 + band.up)) : null,
    band_down_pct: showRange ? band.down : 0,
    band_up_pct: showRange ? band.up : 0,
    // The discount is a pricing decision and the band is a scope warning. They are kept
    // apart on purpose: multiplying them together would hide "I am not sure what this job
    // is" inside "we usually charge less than list".
    discount_pct: DISCOUNT_PCT,
    typical_subtotal: overCap ? null : round2(subtotal * (1 - DISCOUNT_PCT)),
    confidence: confidence || 'low',
    confidence_pct: confidencePct,
    rejected_count: rejected,
    clamped_count: clamped
  }
}

module.exports = {
  priceSelections,
  resolveCode,
  round2,
  money,
  stripPrices,
  ALL_CODES,
  BY_CODE,
  CATALOGUE_TEXT,
  DEFAULT_QTY_MAX,
  DISCOUNT_PCT,
  CONFIDENCE_PCT,
  LINE_VALUE_CAP,
  SUBTOTAL_CAP,
  MAX_LINES
}
