// Job requests dashboard: password gate + list/edit/save. No frameworks, no
// session/JWT machinery — the password is just carried as a header on every
// request (sessionStorage), checked server-side with a constant-time compare.

const STORAGE_KEY = 'gemelec_dashboard_password'

const loginPanel = document.getElementById('dash-login')
const contentPanel = document.getElementById('dash-content')
const passwordInput = document.getElementById('dash-password')
const loginBtn = document.getElementById('dash-login-btn')
const loginError = document.getElementById('dash-login-error')
const loadError = document.getElementById('dash-load-error')
const emptyState = document.getElementById('dash-empty')
const jobList = document.getElementById('job-list')

function getPassword() {
  return sessionStorage.getItem(STORAGE_KEY) || ''
}

function setPassword(value) {
  sessionStorage.setItem(STORAGE_KEY, value)
}

async function apiFetch(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      ...(options.headers || {}),
      'X-Dashboard-Auth': getPassword()
    }
  })
  return response
}

function parseCosting(row) {
  if (!row.ai_draft_costing) return null
  try {
    const parsed = JSON.parse(row.ai_draft_costing)
    parsed.line_items = Array.isArray(parsed.line_items) ? parsed.line_items : []
    parsed.flagged_items = Array.isArray(parsed.flagged_items) ? parsed.flagged_items : []
    parsed.notes = Array.isArray(parsed.notes) ? parsed.notes : []
    parsed.unpriced_items = Array.isArray(parsed.unpriced_items) ? parsed.unpriced_items : []
    return parsed
  } catch {
    return null
  }
}

function money(value) {
  const num = Number(value)
  return Number.isFinite(num) ? num.toFixed(2) : '0.00'
}

// Number(null), Number('') and Number(false) are all 0, and Number.isFinite(0) is true, so
// a plain finite check would render a withheld estimate as a confident "$0.00".
function hasNumber(value) {
  return value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value))
}

function listBlock(className, heading, entries) {
  if (!entries.length) return ''
  return `
    <div class="${className}">
      ${escapeHtml(heading)}
      <ul>${entries.map(e => `<li>${escapeHtml(e.description || '')}${e.reason ? ` — ${escapeHtml(e.reason)}` : ''}</li>`).join('')}</ul>
    </div>`
}

function computeTotal(lineItems) {
  return lineItems.reduce((sum, item) => sum + (Number(item.qty) || 0) * (Number(item.sell_price) || 0), 0)
}

// Mirrors DISCOUNT_PCT in api/_lib/price-book.js. The server sends discount_pct on every
// draft, so this is only the fallback for older rows saved before the field existed.
const FALLBACK_DISCOUNT_PCT = 0.30

function discountOf(costing) {
  const d = Number(costing?.discount_pct)
  return Number.isFinite(d) && d >= 0 && d < 1 ? d : FALLBACK_DISCOUNT_PCT
}

// onChange fires when a row is ADDED or REMOVED. Typing was already covered by the card's
// input listener, but structural edits fired no input event, so the total silently kept the
// old figure: removing the $250 line off a $400 job left "Your price: $280.00" on screen.
// The notes on these drafts actively tell Mani to remove lines the job does not need, so
// this was a documented path to quoting a number that was never recalculated.
function buildCostingTable(costing, onChange = () => {}) {
  const table = document.createElement('table')
  table.className = 'job-costing-table'
  table.innerHTML = `
    <thead>
      <tr><th>Item</th><th>Code</th><th>Qty</th><th>List price</th><th>Your price</th><th></th></tr>
    </thead>
    <tbody></tbody>
  `
  const tbody = table.querySelector('tbody')
  const discount = discountOf(costing)

  function addRow(item = { description: '', item_code: '', qty: 1, sell_price: 0 }, notify = false) {
    const tr = document.createElement('tr')
    tr.innerHTML = `
      <td data-label="Item"><input type="text" class="desc" value="${escapeAttr(item.description || '')}"></td>
      <td data-label="Code"><input type="text" class="code" value="${escapeAttr(item.item_code || '')}"></td>
      <td data-label="Qty"><input type="number" class="qty" min="0" step="1" value="${Number(item.qty) || 1}"></td>
      <td data-label="List price"><input type="number" class="price" min="0" step="0.01" value="${Number(item.sell_price) || 0}"></td>
      <td data-label="Your price" class="job-line-discounted">$${money((Number(item.sell_price) || 0) * (1 - discount))}</td>
      <td><button type="button" class="job-line-remove" aria-label="Remove line">Remove</button></td>
    `
    tr.querySelector('.job-line-remove').addEventListener('click', () => { tr.remove(); onChange() })
    tbody.appendChild(tr)
    if (notify) onChange()
  }

  costing.line_items.forEach(item => addRow(item))

  return { table, addRow }
}

function escapeAttr(value) {
  return String(value).replace(/"/g, '&quot;')
}

function escapeHtml(value) {
  const div = document.createElement('div')
  div.textContent = String(value)
  return div.innerHTML
}

// Job photos are private blobs: their bytes only come out of /api/job-photo, which needs
// the dashboard password in a header. An <img src> cannot send one, so each photo is
// fetched here and handed to the <img> as an object URL.
//
// Rows written before 2026-09-01 hold Google Drive URLs instead of blob pathnames. Those
// are rendered as plain links exactly as before — no migration, because Drive uploads never
// actually succeeded, so in practice there are none.
function isBlobPathname(ref) {
  return ref.startsWith('job-photos/')
}

async function loadPhotoInto(container, ref) {
  const link = document.createElement('a')
  link.target = '_blank'
  link.rel = 'noopener'
  const img = document.createElement('img')
  img.alt = 'Job photo'
  img.loading = 'lazy'
  link.appendChild(img)
  container.appendChild(link)

  if (!isBlobPathname(ref)) {
    link.href = ref
    img.src = ref
    return
  }

  try {
    const response = await apiFetch(`/api/job-photo?pathname=${encodeURIComponent(ref)}`)
    if (!response.ok) throw new Error(`photo ${response.status}`)
    // Object URLs are never revoked: the page holds every card until it reloads, so
    // revoking would blank thumbnails that are still on screen. They die with the page.
    const url = URL.createObjectURL(await response.blob())
    img.src = url
    link.href = url
  } catch (error) {
    console.error('Could not load job photo:', error)
    link.remove()
    if (!container.querySelector('a') && !container.dataset.failed) {
      container.dataset.failed = '1'
      const note = document.createElement('p')
      note.className = 'job-photos-note'
      // A purged photo and a broken one look identical from here, so say both.
      note.textContent = 'Photos for this job are no longer stored (they are kept for 14 days) — they are attached to the notification email in your inbox.'
      container.replaceWith(note)
    }
  }
}

function hydratePhotos(card) {
  const container = card.querySelector('.job-photos')
  if (!container) return
  const refs = (container.dataset.photos || '').split(',').map(s => s.trim()).filter(Boolean)
  refs.forEach(ref => { loadPhotoInto(container, ref) })
}

// The summary arrives as one string that already carries its own structure: a standing
// notice, then "The AI's own summary: ...", then "Why these items:" and a "- CODE: reason"
// line per item. It was being dropped into a <div>, where every newline collapses and the
// whole thing reads as one wall — which is what it looked like on screen, not the model
// being long-winded.
//
// Deliberately tolerant: anything that does not match the expected shape falls through to
// plain paragraphs with the line breaks kept, so a change to the server-side wording
// degrades to "slightly less pretty" rather than "blank block where the summary was".
// The sheet stores an ISO timestamp. Rendering it raw put "2026-09-01T12:53:05.086Z" at the
// top of every card, which nobody reads as a time. Converted in the viewer's own timezone,
// which for this office is Sydney.
function niceDate(iso) {
  const d = new Date(iso)
  if (!iso || Number.isNaN(d.getTime())) return String(iso || '')
  const today = new Date()
  const sameDay = d.toDateString() === today.toDateString()
  const time = d.toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit' })
  if (sameDay) return `Today, ${time}`
  return `${d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' })}, ${time}`
}

function renderSummary(summary) {
  const lines = String(summary || '').split('\n').map(l => l.trim())
  const out = []
  let list = null

  const closeList = () => {
    if (list) { out.push(`<ul class="job-why">${list}</ul>`); list = null }
  }

  for (const line of lines) {
    if (!line) { closeList(); continue }

    // "- CODE: reason" — the per-item reasoning, the part worth scanning.
    const item = line.match(/^[-•]\s*([A-Z0-9][A-Z0-9+/<>._-]*)\s*:\s*(.+)$/)
    if (item) {
      list = (list || '') + `<li><code>${escapeHtml(item[1])}</code> ${escapeHtml(item[2])}</li>`
      continue
    }
    // A bullet that is not code-prefixed still belongs in the list.
    if (/^[-•]\s+/.test(line)) {
      list = (list || '') + `<li>${escapeHtml(line.replace(/^[-•]\s+/, ''))}</li>`
      continue
    }

    closeList()

    if (/^Why these items:?$/i.test(line)) {
      out.push('<h4 class="job-sub">Why these items</h4>')
    } else if (/^The AI's own summary:/i.test(line)) {
      out.push(`<p class="job-ai-para">${escapeHtml(line.replace(/^The AI's own summary:\s*/i, ''))}</p>`)
    } else if (/come from your price list/i.test(line)) {
      // Same sentence on every draft, and the badge above already says it. Kept, but out of
      // the way of the words that actually differ job to job.
      out.push(`<p class="job-standing-note">${escapeHtml(line)}</p>`)
    } else {
      out.push(`<p class="job-ai-para">${escapeHtml(line)}</p>`)
    }
  }
  closeList()
  return out.join('')
}

function renderCard(row) {
  const costing = parseCosting(row)
  const card = document.createElement('div')
  card.className = 'job-card'
  card.dataset.requestId = row.request_id
  card.dataset.status = row.status || 'new'

  const photoRefs = (row.photo_links || '').split(',').map(s => s.trim()).filter(Boolean)

  card.innerHTML = `
    <div class="job-card-head">
      <h3>${escapeHtml(row.full_name || 'Unnamed')}</h3>
      <span class="job-card-date" title="${escapeAttr(row.submitted_at || '')}">${escapeHtml(niceDate(row.submitted_at))}</span>
      <select class="job-status">
        ${['new', 'quoted', 'won', 'lost'].map(s => `<option value="${s}" ${row.status === s ? 'selected' : ''}>${s}</option>`).join('')}
      </select>
    </div>
    ${row.source && row.source !== 'website' ? `<p class="job-source">${escapeHtml(row.source)}</p>` : ''}
    <p class="job-meta"><strong>Phone:</strong> <a href="tel:${escapeAttr(row.phone || '')}">${escapeHtml(row.phone || '')}</a></p>
    ${row.email ? `<p class="job-meta"><strong>Email:</strong> <a href="mailto:${escapeAttr(row.email)}">${escapeHtml(row.email)}</a></p>` : ''}
    ${row.job_address ? `<p class="job-meta"><strong>Address:</strong> ${escapeHtml(row.job_address)}</p>` : ''}
    <div class="job-description">${escapeHtml(row.description || '')}</div>
    ${photoRefs.length
      ? `<div class="job-photos" data-photos="${escapeAttr(photoRefs.join(','))}"></div>`
      : '<p class="job-photos-note">Photos were sent as attachments on the notification email for this request — check your inbox.</p>'}
    <span class="job-ai-label">AI draft — review before quoting, not sent to customer</span>
    ${costing?.summary ? `<div class="job-ai-summary">${renderSummary(costing.summary)}</div>` : ''}
    ${hasNumber(costing?.estimate_low) && hasNumber(costing?.estimate_high) ? `
      <div class="job-ai-range">AI draft range: $${money(costing.estimate_low)}${Number(costing.estimate_high) !== Number(costing.estimate_low) ? ` – $${money(costing.estimate_high)}` : ''}
        ${costing.range_note ? `<span class="job-ai-range-note">${escapeHtml(costing.range_note)}</span>` : ''}
      </div>` : ''}
    ${costing && costing.line_items.length && !hasNumber(costing.estimate_low) ? `
      <div class="job-ai-range">No AI range for this one — the items below are priced from your list, but the total is above the ceiling this system will put a number on. Total it yourself.</div>` : ''}
    <div class="job-costing-slot"></div>
    ${listBlock('job-flagged', 'Check these before you quote:', costing?.flagged_items || [])}
    ${listBlock('job-notes', "Your own price-list rulings that applied here:", costing?.notes || [])}
    ${listBlock('job-unpriced', "The AI's own notes — not from your price list, and not checked by this system:", costing?.unpriced_items || [])}
    <div class="job-total-slot"></div>
    <div class="job-description-slot"></div>
    <div class="job-actions">
      <button type="button" class="btn btn-sm job-add-line">+ Add line</button>
      <button type="button" class="btn btn-primary btn-sm job-save">Save changes</button>
      <button type="button" class="btn btn-sm job-describe">Generate quote description</button>
      <button type="button" class="btn btn-sm job-copy">Copy quote text</button>
      <span class="job-save-status"></span>
      <button type="button" class="btn btn-sm job-delete">Delete</button>
    </div>
  `

  const costingSlot = card.querySelector('.job-costing-slot')
  const totalSlot = card.querySelector('.job-total-slot')

  let tableRef

  if (costing) {
    const built = buildCostingTable(costing, () => refreshTotal())
    tableRef = built
    costingSlot.appendChild(built.table)
  } else {
    costingSlot.innerHTML = '<p class="job-no-costing">No AI draft available for this one — price manually.</p>'
    const built = buildCostingTable({ line_items: [] }, () => refreshTotal())
    tableRef = built
    costingSlot.appendChild(built.table)
  }

  function refreshTotal() {
    const rows = [...card.querySelectorAll('.job-costing-table tbody tr')]
    const total = rows.reduce((sum, tr) => {
      const qty = Number(tr.querySelector('.qty').value) || 0
      const price = Number(tr.querySelector('.price').value) || 0
      return sum + qty * price
    }, 0)
    const discount = discountOf(costing)
    // Recompute the derived column from the price column on every keystroke, so the two
    // can never drift apart while Mani is editing.
    rows.forEach(tr => {
      const cell = tr.querySelector('.job-line-discounted')
      if (!cell) return
      const qty = Number(tr.querySelector('.qty').value) || 0
      const price = Number(tr.querySelector('.price').value) || 0
      cell.textContent = `$${money(price * (1 - discount))}`
      cell.title = `${qty} x $${money(price * (1 - discount))} = $${money(qty * price * (1 - discount))}`
    })
    const pct = Number(costing?.confidence_pct)
    const confidenceLine = Number.isFinite(pct)
      ? `<div class="job-confidence">AI confidence in these picks: ${pct}%${costing?.confidence ? ` (${escapeHtml(costing.confidence)})` : ''} — how likely the right items in the right quantities, not the prices.</div>`
      : ''
    if (!rows.length) {
      totalSlot.innerHTML = ''
      return
    }
    totalSlot.innerHTML = `
      <div class="job-total">
        <span class="job-total-rrp">List total: $${money(total)}</span>
        <span class="job-total-sep">/</span>
        <span class="job-total-yours">Your price: $${money(total * (1 - discount))}</span>
        <span class="job-total-note">list is the worst case; your price is ${Math.round(discount * 100)}% off it</span>
      </div>
      ${confidenceLine}`
  }

  card.addEventListener('input', (e) => {
    if (e.target.matches('.qty, .price')) refreshTotal()
  })

  card.querySelector('.job-status').addEventListener('change', (e) => {
    card.dataset.status = e.target.value
  })
  refreshTotal()

  card.querySelector('.job-add-line').addEventListener('click', () => tableRef.addRow(undefined, true))

  card.querySelector('.job-save').addEventListener('click', async () => {
    const statusEl = card.querySelector('.job-save-status')
    const rows = [...card.querySelectorAll('.job-costing-table tbody tr')].map(tr => ({
      description: tr.querySelector('.desc').value.trim(),
      item_code: tr.querySelector('.code').value.trim(),
      qty: Number(tr.querySelector('.qty').value) || 0,
      sell_price: Number(tr.querySelector('.price').value) || 0
    }))
    const total = computeTotal(rows)
    // Spread first, then override. Without this the save rebuilds the costing from a
    // fixed set of keys and silently drops everything else the draft carried, with a
    // "Saved." confirmation on top.
    const updatedCosting = {
      ...(costing || {}),
      summary: costing?.summary || '',
      line_items: rows,
      flagged_items: costing?.flagged_items || [],
      estimate_low: total,
      estimate_high: total,
      // These all describe the AI's ORIGINAL figures. Once the table has been edited they
      // are stale, and carrying them through meant the card came back showing the old AI
      // range and subtotal directly above the number that had just replaced them.
      range_note: '',
      subtotal: total,
      band_down_pct: 0,
      band_up_pct: 0,
      over_cap: false
    }

    statusEl.textContent = 'Saving...'
    try {
      const response = await apiFetch('/api/job-requests-update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          request_id: row.request_id,
          ai_draft_costing: JSON.stringify(updatedCosting),
          status: card.querySelector('.job-status').value
        })
      })
      const result = await response.json().catch(() => ({}))
      if (!response.ok || result.ok === false) throw new Error(result.message || 'Save failed')
      statusEl.textContent = 'Saved.'
      setTimeout(() => { statusEl.textContent = '' }, 2500)
    } catch (error) {
      statusEl.textContent = error.message || 'Save failed.'
    }
  })

  card.querySelector('.job-delete').addEventListener('click', async () => {
    const btn = card.querySelector('.job-delete')
    const statusEl = card.querySelector('.job-save-status')
    // Names the customer in the prompt rather than asking "are you sure?". On a page of
    // similar-looking cards, the only useful confirmation is one that says WHICH job.
    const who = row.full_name || 'this job request'
    if (!confirm(`Delete ${who}?\n\nThe sheet row and any photos are removed for good. This cannot be undone.`)) return

    btn.disabled = true
    btn.textContent = 'Deleting...'
    try {
      const response = await apiFetch('/api/job-requests-delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ request_id: row.request_id })
      })
      const result = await response.json().catch(() => ({}))
      if (!response.ok || result.ok === false) throw new Error(result.message || 'Could not delete.')
      // Removed from the page immediately rather than reloading the list: a reload would
      // scroll the office back to the top and lose any other card they were part-way
      // through editing.
      card.remove()
    } catch (error) {
      btn.disabled = false
      btn.textContent = 'Delete'
      statusEl.textContent = error.message || 'Could not delete.'
    }
  })

  card.querySelector('.job-describe').addEventListener('click', async () => {
    const btn = card.querySelector('.job-describe')
    const slot = card.querySelector('.job-description-slot')
    // Reads the table as it stands, so anything Mani has added or deleted is what the
    // customer gets told about.
    const rows = [...card.querySelectorAll('.job-costing-table tbody tr')].map(tr => ({
      description: tr.querySelector('.desc').value.trim(),
      item_code: tr.querySelector('.code').value.trim(),
      qty: Number(tr.querySelector('.qty').value) || 0
    })).filter(r => r.description)

    if (!rows.length) {
      slot.innerHTML = '<p class="job-desc-error">Add at least one line item first.</p>'
      return
    }

    btn.disabled = true
    btn.textContent = 'Writing...'
    slot.innerHTML = '<p class="job-desc-pending">Writing the scope description — about twenty seconds.</p>'
    try {
      const response = await apiFetch('/api/generate-description', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ line_items: rows, description: row.description || '' })
      })
      const result = await response.json().catch(() => ({}))
      if (!response.ok || result.ok === false) throw new Error(result.message || 'Could not generate a description.')

      slot.innerHTML = `
        <div class="job-desc-box">
          <span class="job-desc-label">Quote description — draft, read it before it goes out</span>
          <textarea class="job-desc-text" rows="16"></textarea>
          <div class="job-desc-actions">
            <button type="button" class="btn btn-sm job-desc-copy">Copy for Tradify</button>
            <span class="job-desc-status"></span>
          </div>
        </div>`
      // Set as a value, never interpolated into the HTML above — this string is model output
      // and the box it lands in is the one thing here that gets pasted into a customer quote.
      slot.querySelector('.job-desc-text').value = result.description

      slot.querySelector('.job-desc-copy').addEventListener('click', async () => {
        const text = slot.querySelector('.job-desc-text').value
        const status = slot.querySelector('.job-desc-status')
        try {
          await navigator.clipboard.writeText(text)
          status.textContent = 'Copied.'
          setTimeout(() => { status.textContent = '' }, 2000)
        } catch {
          window.prompt('Copy this description:', text)
        }
      })
    } catch (error) {
      slot.innerHTML = `<p class="job-desc-error">${escapeHtml(error.message || 'Could not generate a description.')}</p>`
    } finally {
      btn.disabled = false
      btn.textContent = 'Generate quote description'
    }
  })

  card.querySelector('.job-copy').addEventListener('click', async () => {
    const rows = [...card.querySelectorAll('.job-costing-table tbody tr')].map(tr => ({
      description: tr.querySelector('.desc').value.trim(),
      qty: Number(tr.querySelector('.qty').value) || 0,
      sell_price: Number(tr.querySelector('.price').value) || 0
    }))
    const total = computeTotal(rows)
    // Mani's price, not the list ceiling: the list is a worst case he rarely charges, and
    // this text goes to a customer. Editing the List price column moves this with it, so
    // there is no way to discount twice.
    const discount = discountOf(costing)
    const lines = rows.map(r => `${r.qty} x ${r.description} — $${money(r.sell_price * (1 - discount))}`)
    const text = [
      `Quote for ${row.full_name}`,
      row.job_address ? `Address: ${row.job_address}` : '',
      '',
      ...lines,
      '',
      `Total: $${money(total)}`
    ].filter(Boolean).join('\n')

    try {
      await navigator.clipboard.writeText(text)
      const statusEl = card.querySelector('.job-save-status')
      statusEl.textContent = 'Copied.'
      setTimeout(() => { statusEl.textContent = '' }, 2000)
    } catch {
      window.prompt('Copy this quote text:', text)
    }
  })

  return card
}

// Counts by status. Twenty cards down the page it is not obvious how many are still
// waiting on someone, and that is the only question worth answering on arrival.
function renderCounts(requests) {
  const bar = document.getElementById('dash-counts')
  if (!bar) return
  const tally = { new: 0, quoted: 0, won: 0, lost: 0 }
  requests.forEach(r => { const k = r.status || 'new'; if (k in tally) tally[k] += 1 })
  bar.innerHTML = Object.entries(tally)
    .map(([k, n]) => `<span class="dash-count" data-status="${k}"><strong>${n}</strong> ${k}</span>`)
    .join('')
  bar.hidden = false
}

async function loadRequests() {
  loadError.style.display = 'none'
  loginError.style.display = 'none'
  const wasLoggedIn = contentPanel.style.display !== 'none'

  try {
    const response = await apiFetch('/api/job-requests-list')
    const result = await response.json().catch(() => ({}))

    if (response.status === 401) {
      loginPanel.style.display = 'block'
      contentPanel.style.display = 'none'
      loginError.textContent = 'Incorrect password.'
      loginError.style.display = 'block'
      sessionStorage.removeItem(STORAGE_KEY)
      return
    }

    if (!response.ok || result.ok === false) {
      throw new Error(result.message || 'Could not load job requests.')
    }

    loginPanel.style.display = 'none'
    contentPanel.style.display = 'block'
    jobList.innerHTML = ''

    if (!result.requests.length) {
      emptyState.style.display = 'block'
      return
    }

    emptyState.style.display = 'none'
    renderCounts(result.requests)
    result.requests.forEach(row => {
      const card = renderCard(row)
      jobList.appendChild(card)
      hydratePhotos(card)
    })
  } catch (error) {
    const message = error.message || 'Could not load job requests.'
    // A thrown network error (as opposed to a handled 401/non-ok response) means we
    // never got a chance to reveal contentPanel — if this happened before any
    // successful load, the error has to surface on the login screen instead, or it
    // renders invisibly inside the still-hidden content panel.
    if (wasLoggedIn) {
      loadError.textContent = message
      loadError.style.display = 'block'
    } else {
      loginError.textContent = message
      loginError.style.display = 'block'
    }
  }
}

loginBtn.addEventListener('click', () => {
  const value = passwordInput.value.trim()
  if (!value) return
  setPassword(value)
  loginError.style.display = 'none'
  loadRequests()
})

passwordInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') loginBtn.click()
})

if (getPassword()) {
  loadRequests()
}
