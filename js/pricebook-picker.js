// Price-book picker for the staff pages: type a few letters of a line item, pick it from the
// list, and its description, code and list price fill themselves in. Mani: "I don't want to
// have to type every line item."
//
// The data comes from /api/price-book (api/price-book.js), which serves api/price-list.json to
// a signed-in staff device of either role. `price` there is the list sell_price, ex GST — the
// RRP, never the discounted figure. Techs see RRP only; any discount is Mani's, on the
// dashboard.
//
// window.GxPricebook:
//   load()                                fetch the price book once; resolves { items, companions, popular }
//   search(query, limit = 8)              matching items, best first (see search below)
//   lookup(code)                          the item with exactly this code (any case), or null
//   companionsFor(code, excludeCodes)     items often invoiced alongside `code`, minus the excluded codes
//   attach(input, onPick, options)        autocomplete dropdown under a text input (options: see attach)
//   showCompanions(box, items, onChoose)  fills `box` with "Often added with:" chips
//
// All of it is optional to the pages that use it. If this file fails to load or the API
// says no, the inputs stay plain inputs and free typing works exactly as it did before —
// a line that isn't in the price book is always allowed.
//
// Wrapped in a function so none of these names reach the page's global scope: the dashboard
// script declares its own top-level money(), and two classic scripts share one global scope.
;(function () {
  if (window.GxPricebook) return

  const ENDPOINT = '/api/price-book'
  const MAX_OPTIONS = 8
  // After a failed load, calls within this window get the same failure rather than a new
  // request per keystroke. The next one after it tries again (a dropped signal comes back).
  const RETRY_AFTER_MS = 30000
  // Long enough for a tap on an option to land before the list closes on blur.
  const BLUR_CLOSE_MS = 200
  const GAP = 4
  const GUTTER = 8
  const MIN_WIDTH = 340
  const MAX_WIDTH = 560
  const MAX_HEIGHT = 360
  const MIN_HEIGHT = 132 // three 44px rows
  // Less room than this under the input (a phone with its keyboard up) and more above it:
  // open upwards instead.
  const FLIP_BELOW = 180
  // Shown as the list's one line when there is nothing to pick, so "not in the price book",
  // "still loading" and "can't load" each read as what they are rather than as nothing
  // happening. A page can word the first and last for itself (see attach).
  const NO_MATCH_TEXT = 'No match in the price book. Type the line in yourself.'
  const LOADING_TEXT = 'Loading the price book…'
  const UNAVAILABLE_TEXT = "Can't reach the price book right now. Type the line in yourself."

  // Trade words for the same thing. A typed word that is one of these also matches the
  // others, as whole words (so "ev" finds "EV Charger" without also finding "level").
  const SYNONYM_GROUPS = [
    ['gpo', 'power point', 'powerpoint', 'outlet'],
    ['downlight', 'light'],
    ['rcbo', 'rcd', 'safety switch'],
    ['sb', 'switchboard'],
    ['cctv', 'camera'],
    ['ev', 'charger'],
    ['t&t', 'test and tag', 'test & tag', 'tandt']
  ]
  const SYNONYMS = new Map()
  for (const group of SYNONYM_GROUPS) {
    for (const term of group) SYNONYMS.set(term, group)
  }
  // Multi-word terms are pulled out of the query whole, longest first, so "safety switch"
  // is one search term rather than "safety" and "switch" separately.
  const PHRASES = SYNONYM_GROUPS.flat()
    .filter(term => term.includes(' '))
    .sort((a, b) => b.length - a.length)

  let state = null
  let pending = null
  let failedAt = 0

  function plainObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  }

  function own(object, key) {
    return Object.prototype.hasOwnProperty.call(object, key) ? object[key] : undefined
  }

  function normalise(value) {
    return String(value || '').toLowerCase().replace(/\s+/g, ' ').trim()
  }

  // Punctuation to spaces, keeping "&" for "t&t" and "test & tag".
  function wordsOf(value) {
    return normalise(value).replace(/[^a-z0-9&]+/g, ' ').trim()
  }

  function money(value) {
    return `$${Number(value).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  }

  // Mined counts may arrive as a bare number or as { count }.
  function countOf(raw) {
    const n = Number(raw && typeof raw === 'object' ? raw.count : raw)
    return Number.isFinite(n) ? n : 0
  }

  // A companion entry may be a code string, { code }, or [code, count].
  function codeOf(entry) {
    if (typeof entry === 'string') return entry
    if (Array.isArray(entry)) return String(entry[0] || '')
    if (entry && typeof entry === 'object') return String(entry.code || entry.item_code || '')
    return ''
  }

  function prepare(result) {
    const items = []
    const records = []
    const byCode = new Map()
    const byFolded = new Map()
    const popular = plainObject(result.popular)

    for (const raw of result.items) {
      if (!raw || typeof raw.code !== 'string' || !raw.code || byCode.has(raw.code)) continue
      const item = { code: raw.code, description: String(raw.description || ''), price: Number(raw.price) || 0 }
      items.push(item)
      byCode.set(item.code, item)
      if (!byFolded.has(item.code.toLowerCase())) byFolded.set(item.code.toLowerCase(), item)
      const text = normalise(`${item.code} ${item.description}`)
      records.push({
        item,
        text,
        words: ` ${wordsOf(text)} `,
        descWords: ` ${wordsOf(item.description)} `,
        codeKey: normalise(item.code),
        pop: countOf(own(popular, item.code)),
        order: records.length
      })
    }

    return { items, records, byCode, byFolded, companions: plainObject(result.companions), popular }
  }

  // Fetched once per page. Every caller must handle the rejection: offline, signed out, or
  // an older deployment without the endpoint all land there, and all mean "no picker".
  function load() {
    if (pending && !(failedAt && Date.now() - failedAt > RETRY_AFTER_MS)) return pending
    failedAt = 0
    pending = fetch(ENDPOINT, { credentials: 'same-origin' })
      .then(response => {
        if (!response.ok) throw new Error(`price book ${response.status}`)
        return response.json()
      })
      .then(result => {
        if (!result || result.ok === false || !Array.isArray(result.items)) throw new Error('price book unreadable')
        state = prepare(result)
        return { items: state.items, companions: state.companions, popular: state.popular }
      })
    pending.catch(error => {
      failedAt = Date.now()
      console.warn('Price book unavailable, line items stay free text:', (error && error.message) || error)
    })
    return pending
  }

  function tokenize(query) {
    let rest = ` ${normalise(query)} `
    const tokens = []
    for (const phrase of PHRASES) {
      const needle = ` ${phrase} `
      while (rest.includes(needle)) {
        tokens.push(phrase)
        rest = rest.replace(needle, ' ')
      }
    }
    for (const token of rest.split(' ')) {
      if (token) tokens.push(token)
    }
    return tokens
  }

  // What the typed word matches as it stands (anywhere, so half a word still finds things),
  // plus its singular and its synonyms (whole words only).
  function matcherFor(token) {
    const stems = [token]
    if (token.length > 3 && token.endsWith('s')) stems.push(token.slice(0, -1))
    const alternatives = []
    for (const stem of stems) {
      for (const term of SYNONYMS.get(stem) || []) {
        if (!stems.includes(term)) alternatives.push(` ${wordsOf(term)} `)
      }
    }
    return record => stems.some(stem => record.text.includes(stem)) ||
      alternatives.some(term => record.words.includes(term))
  }

  // Every typed word (after synonyms) must appear in the code or the description. Best first:
  // an exact code, then a description containing the whole query as a phrase (from the start
  // of a word), then what gets invoiced most, then the shortest description.
  function search(query, limit = MAX_OPTIONS) {
    if (!state) return []
    const q = normalise(query)
    if (!q) return []
    const tests = tokenize(q).map(matcherFor)
    // The singular counts as the phrase too. Without it "downlights" gave no description the
    // phrase bonus, and the synonym "light" put flood lights above half the downlights.
    const phrases = [wordsOf(q)]
    if (q.length > 3 && q.endsWith('s')) phrases.push(wordsOf(q.slice(0, -1)))
    const hits = []
    for (const record of state.records) {
      if (!tests.every(test => test(record))) continue
      hits.push({
        record,
        exact: record.codeKey === q ? 1 : 0,
        phrase: phrases.some(phrase => phrase && record.descWords.includes(` ${phrase}`)) ? 1 : 0
      })
    }
    hits.sort((a, b) =>
      (b.exact - a.exact) ||
      (b.phrase - a.phrase) ||
      (b.record.pop - a.record.pop) ||
      (a.record.item.description.length - b.record.item.description.length) ||
      (a.record.order - b.record.order))
    const max = Math.max(1, Math.floor(Number(limit)) || MAX_OPTIONS)
    return hits.slice(0, max).map(hit => hit.record.item)
  }

  // Exact code, falling back to a case-insensitive match that returns the canonical code.
  // Never a prefix or nearest match: TANDT and TANDTESTAB are $7.50 and $250.
  function lookup(code) {
    if (!state || typeof code !== 'string') return null
    const raw = code.trim()
    if (!raw) return null
    return state.byCode.get(raw) || state.byFolded.get(raw.toLowerCase()) || null
  }

  function companionsFor(code, excludeCodes) {
    const base = lookup(code)
    if (!base) return []
    const list = own(state.companions, base.code)
    if (!Array.isArray(list)) return []
    const skip = new Set([...(excludeCodes || [])].map(c => String(c).trim().toLowerCase()))
    skip.add(base.code.toLowerCase())
    const out = []
    for (const entry of list) {
      const item = lookup(codeOf(entry))
      if (!item || skip.has(item.code.toLowerCase())) continue
      skip.add(item.code.toLowerCase())
      out.push(item)
    }
    return out
  }

  // ---------------------------------------------------------------- the dropdown
  //
  // One list for the whole page (only one input has focus at a time), appended to <body>
  // and placed in page coordinates from the input's getBoundingClientRect. Not a child of
  // the input's cell: the dashboard's costing table is a <table> on a desktop and a stack of
  // display:block rows on a phone, and a list nested in a cell either stretches the row or
  // gets cut off by the first box around it with overflow set. Absolute rather than fixed,
  // so it scrolls with the page on its own; position() reruns only when the layout moves
  // (a resize, a phone keyboard opening, an inner box scrolling).

  let listbox = null
  let current = null // the attached input whose options are showing
  let frame = 0

  function ensureListbox() {
    if (listbox) return listbox
    listbox = document.createElement('ul')
    listbox.id = 'gx-pb-listbox'
    listbox.className = 'gx-pb-list'
    listbox.setAttribute('role', 'listbox')
    listbox.setAttribute('aria-label', 'Price book matches')
    listbox.hidden = true
    // Pressing an option must not take focus from the input: that keeps a phone's keyboard
    // up and stops the input's blur racing the click.
    listbox.addEventListener('mousedown', e => e.preventDefault())
    listbox.addEventListener('click', e => {
      // [data-index]: the "no match" line is an option for the listbox's sake, not a pick.
      const option = e.target.closest('[role="option"][data-index]')
      if (option && current) choose(current, Number(option.dataset.index))
    })
    document.body.appendChild(listbox)
    window.addEventListener('resize', schedulePosition)
    document.addEventListener('scroll', schedulePosition, { capture: true, passive: true })
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', schedulePosition)
      window.visualViewport.addEventListener('scroll', schedulePosition)
    }
    return listbox
  }

  function schedulePosition(e) {
    if (!current || frame || (e && e.target === listbox)) return
    frame = requestAnimationFrame(() => {
      frame = 0
      position()
    })
  }

  function position() {
    if (!current || !listbox || listbox.hidden) return
    const input = current.input
    const rect = input.getBoundingClientRect()
    if (!input.isConnected || (!rect.width && !rect.height)) {
      close()
      return
    }
    // The visual viewport is the part actually on screen: it shrinks when a phone's
    // keyboard opens, and the layout viewport does not.
    const vv = window.visualViewport
    const viewTop = vv ? vv.offsetTop : 0
    const viewLeft = vv ? vv.offsetLeft : 0
    const viewWidth = vv ? vv.width : document.documentElement.clientWidth
    const viewHeight = vv ? vv.height : window.innerHeight

    const width = Math.min(Math.max(rect.width, MIN_WIDTH), MAX_WIDTH, viewWidth - GUTTER * 2)
    const left = Math.max(viewLeft + GUTTER, Math.min(rect.left, viewLeft + viewWidth - GUTTER - width))
    const below = viewTop + viewHeight - rect.bottom - GAP - GUTTER
    const above = rect.top - viewTop - GAP - GUTTER
    const upwards = below < FLIP_BELOW && above > below

    listbox.style.width = `${width}px`
    listbox.style.maxHeight = `${Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, upwards ? above : below))}px`
    listbox.style.left = `${left + window.scrollX}px`
    const top = upwards ? rect.top - GAP - listbox.offsetHeight : rect.bottom + GAP
    listbox.style.top = `${top + window.scrollY}px`
  }

  // Built from DOM nodes and textContent only. The descriptions are data, and data is never
  // parsed as HTML here.
  function optionFor(item, index) {
    const option = document.createElement('li')
    option.id = `gx-pb-opt-${index}`
    option.className = 'gx-pb-option'
    option.setAttribute('role', 'option')
    option.setAttribute('aria-selected', 'false')
    option.dataset.index = String(index)

    const desc = document.createElement('span')
    desc.className = 'gx-pb-desc'
    desc.textContent = item.description
    const meta = document.createElement('span')
    meta.className = 'gx-pb-meta'
    const code = document.createElement('span')
    code.className = 'gx-pb-code'
    code.textContent = item.code
    const price = document.createElement('span')
    price.className = 'gx-pb-price'
    price.textContent = money(item.price)
    meta.append(code, price)
    option.append(desc, meta)
    return option
  }

  // The one line shown when there is nothing to pick. An option to the listbox, but
  // aria-disabled and with no data-index, so neither a tap nor Enter can choose it.
  function messageRow(text) {
    const row = document.createElement('li')
    row.className = 'gx-pb-message'
    row.setAttribute('role', 'option')
    row.setAttribute('aria-disabled', 'true')
    row.setAttribute('aria-selected', 'false')
    row.textContent = text
    return row
  }

  // With no results, `message` is the list's only line.
  function open(ctl, results, active, message) {
    const list = ensureListbox()
    if (current && current !== ctl) close()
    current = ctl
    ctl.results = results
    list.textContent = ''
    if (results.length) results.forEach((item, i) => list.appendChild(optionFor(item, i)))
    else list.appendChild(messageRow(message || NO_MATCH_TEXT))
    list.hidden = false
    list.scrollTop = 0
    ctl.input.setAttribute('aria-expanded', 'true')
    // Sized first, so setActive measures the list at the height it will actually have.
    position()
    setActive(ctl, results.length ? active : -1)
  }

  function close() {
    if (!current) return
    const { input } = current
    current.results = []
    current.active = -1
    current = null
    if (listbox) {
      listbox.hidden = true
      listbox.textContent = ''
    }
    input.setAttribute('aria-expanded', 'false')
    input.removeAttribute('aria-activedescendant')
  }

  function setActive(ctl, index) {
    ctl.active = index
    const options = listbox.children
    for (let i = 0; i < options.length; i++) {
      options[i].setAttribute('aria-selected', i === index ? 'true' : 'false')
    }
    const option = options[index]
    if (!option) {
      ctl.input.removeAttribute('aria-activedescendant')
      return
    }
    ctl.input.setAttribute('aria-activedescendant', option.id)
    // Scroll the list, never the page, to keep the highlighted option in view.
    if (option.offsetTop < listbox.scrollTop) {
      listbox.scrollTop = option.offsetTop
    } else if (option.offsetTop + option.offsetHeight > listbox.scrollTop + listbox.clientHeight) {
      listbox.scrollTop = option.offsetTop + option.offsetHeight - listbox.clientHeight
    }
  }

  function choose(ctl, index) {
    const item = ctl.results[index]
    if (!item) return
    ctl.ticket += 1 // a search still in flight must not reopen the list over the pick
    close()
    ctl.input.value = item.description
    try {
      ctl.onPick(item, ctl.input)
    } catch (error) {
      console.error('Price-book pick failed:', error)
    }
  }

  function refresh(ctl, highlightFirst) {
    const query = ctl.input.value
    const ticket = ++ctl.ticket
    if (!query.trim()) {
      if (current === ctl) close()
      return
    }
    // A later keystroke, or focus moving on, while the list was loading.
    const stale = () => ticket !== ctl.ticket || document.activeElement !== ctl.input
    // Only until the price book is here (a first load on a weak signal, or a retry). A load
    // that has just failed rejects straight away, so this is replaced before it is painted.
    if (!state) open(ctl, [], -1, LOADING_TEXT)
    load().then(() => {
      if (stale()) return
      open(ctl, search(query, MAX_OPTIONS), highlightFirst ? 0 : -1, ctl.noMatchText)
    }, () => {
      if (!stale()) open(ctl, [], -1, ctl.unavailableText)
    }).catch(() => {})
  }

  // Sets the input's value to the picked description, then calls onPick(item, input) to fill
  // in the rest. Typing without picking is untouched: Enter only picks once an option has
  // been highlighted with the arrow keys, so free text is never swapped for a list item.
  //
  // options (all optional):
  //   enterPicksFirst  Enter with the list open and nothing highlighted picks the top match.
  //                    For a box that never keeps free text (the portal's search): a phone
  //                    has no arrow keys, so without it Return/Go there would do nothing.
  //   noMatchText      the line shown when nothing matches (default: type it in yourself)
  //   unavailableText  the line shown when the price book won't load
  function attach(input, onPick, options) {
    if (!input || input.dataset.gxPricebook) return
    input.dataset.gxPricebook = '1'
    const opts = options || {}
    const ctl = {
      input,
      onPick: typeof onPick === 'function' ? onPick : () => {},
      enterPicksFirst: Boolean(opts.enterPicksFirst),
      noMatchText: opts.noMatchText || NO_MATCH_TEXT,
      unavailableText: opts.unavailableText || UNAVAILABLE_TEXT,
      results: [],
      active: -1,
      ticket: 0,
      blurTimer: 0
    }
    const list = ensureListbox()

    input.classList.add('gx-pb-input')
    input.setAttribute('role', 'combobox')
    input.setAttribute('aria-autocomplete', 'list')
    input.setAttribute('aria-expanded', 'false')
    input.setAttribute('aria-controls', list.id)
    // The browser's own autofill list would open on top of this one. And iOS autocorrect fires
    // on a space, so "gpo " became "go " and the list jumped to something else. (Capitals are
    // left alone: the search ignores case, and a line typed by hand still gets its capital.)
    input.setAttribute('autocomplete', 'off')
    input.setAttribute('autocorrect', 'off')
    if (!input.getAttribute('aria-label') && !(input.labels && input.labels.length)) {
      input.setAttribute('aria-label', 'Item, type to search the price book')
    }

    input.addEventListener('focus', () => {
      clearTimeout(ctl.blurTimer)
      load().catch(() => {})
    })
    input.addEventListener('input', () => refresh(ctl, false))
    input.addEventListener('blur', () => {
      clearTimeout(ctl.blurTimer)
      ctl.blurTimer = setTimeout(() => {
        if (current === ctl && document.activeElement !== input) close()
      }, BLUR_CLOSE_MS)
    })
    input.addEventListener('keydown', e => {
      if (e.isComposing) return
      const isOpen = current === ctl
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        if (!isOpen) {
          if (e.key === 'ArrowDown' && input.value.trim()) {
            e.preventDefault()
            refresh(ctl, true)
          }
          return
        }
        e.preventDefault()
        const count = ctl.results.length
        if (!count) return // only the "no match" line is showing
        const step = e.key === 'ArrowDown' ? 1 : -1
        const next = ctl.active < 0 ? (step > 0 ? 0 : count - 1) : (ctl.active + step + count) % count
        setActive(ctl, next)
      } else if (e.key === 'Enter') {
        // The highlighted option, or the top one where the page asked for that.
        const index = ctl.active >= 0 ? ctl.active : (ctl.enterPicksFirst ? 0 : -1)
        if (isOpen && ctl.results[index]) {
          e.preventDefault()
          choose(ctl, index)
        }
      } else if (e.key === 'Escape') {
        if (isOpen) {
          e.preventDefault()
          e.stopPropagation()
          close()
        }
      } else if (e.key === 'Tab') {
        if (isOpen) close()
      }
    })
  }

  // "Often added with:" and up to however many chips the caller passes. Hidden when there
  // are none. onChoose(item, chip) runs on a tap; the caller adds the line.
  function showCompanions(box, items, onChoose) {
    if (!box) return
    box.textContent = ''
    if (!Array.isArray(items) || !items.length) {
      box.hidden = true
      return
    }
    box.classList.add('gx-pb-often')
    box.setAttribute('role', 'group')
    box.setAttribute('aria-label', 'Often added with')
    const label = document.createElement('span')
    label.className = 'gx-pb-often-label'
    label.textContent = 'Often added with:'
    box.appendChild(label)
    for (const item of items) {
      const chip = document.createElement('button')
      chip.type = 'button'
      chip.className = 'gx-pb-chip'
      chip.title = item.code
      chip.setAttribute('aria-label', `Add a line: ${item.description}, ${money(item.price)}`)
      const desc = document.createElement('span')
      desc.className = 'gx-pb-chip-desc'
      desc.textContent = `+ ${item.description}`
      const price = document.createElement('span')
      price.className = 'gx-pb-chip-price'
      price.textContent = money(item.price)
      chip.append(desc, price)
      chip.addEventListener('click', () => {
        if (typeof onChoose === 'function') onChoose(item, chip)
      })
      box.appendChild(chip)
    }
    box.hidden = false
  }

  window.GxPricebook = { load, search, lookup, companionsFor, attach, showCompanions }
})()
