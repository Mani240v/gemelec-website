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

function buildCostingTable(costing) {
  const table = document.createElement('table')
  table.className = 'job-costing-table'
  table.innerHTML = `
    <thead>
      <tr><th>Item</th><th>Code</th><th>Qty</th><th>Sell price</th><th></th></tr>
    </thead>
    <tbody></tbody>
  `
  const tbody = table.querySelector('tbody')

  function addRow(item = { description: '', item_code: '', qty: 1, sell_price: 0 }) {
    const tr = document.createElement('tr')
    tr.innerHTML = `
      <td><input type="text" class="desc" value="${escapeAttr(item.description || '')}"></td>
      <td><input type="text" class="code" value="${escapeAttr(item.item_code || '')}"></td>
      <td><input type="number" class="qty" min="0" step="1" value="${Number(item.qty) || 1}"></td>
      <td><input type="number" class="price" min="0" step="0.01" value="${Number(item.sell_price) || 0}"></td>
      <td><button type="button" class="job-line-remove" aria-label="Remove line">Remove</button></td>
    `
    tr.querySelector('.job-line-remove').addEventListener('click', () => tr.remove())
    tbody.appendChild(tr)
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

function renderCard(row) {
  const costing = parseCosting(row)
  const card = document.createElement('div')
  card.className = 'job-card'
  card.dataset.requestId = row.request_id

  const photoUrls = (row.photo_links || '').split(',').map(s => s.trim()).filter(Boolean)

  card.innerHTML = `
    <div class="job-card-head">
      <h3>${escapeHtml(row.full_name || 'Unnamed')}</h3>
      <span class="job-card-date">${escapeHtml(row.submitted_at || '')}</span>
      <select class="job-status">
        ${['new', 'quoted', 'won', 'lost'].map(s => `<option value="${s}" ${row.status === s ? 'selected' : ''}>${s}</option>`).join('')}
      </select>
    </div>
    <p class="job-meta"><strong>Phone:</strong> <a href="tel:${escapeAttr(row.phone || '')}">${escapeHtml(row.phone || '')}</a></p>
    ${row.email ? `<p class="job-meta"><strong>Email:</strong> <a href="mailto:${escapeAttr(row.email)}">${escapeHtml(row.email)}</a></p>` : ''}
    ${row.job_address ? `<p class="job-meta"><strong>Address:</strong> ${escapeHtml(row.job_address)}</p>` : ''}
    <div class="job-description">${escapeHtml(row.description || '')}</div>
    ${photoUrls.length
      ? `<div class="job-photos">${photoUrls.map(url => `<a href="${escapeAttr(url)}" target="_blank" rel="noopener"><img src="${escapeAttr(url)}" alt="Job photo" loading="lazy"></a>`).join('')}</div>`
      : '<p class="job-photos-note">Photos were sent as attachments on the notification email for this request — check your inbox.</p>'}
    <span class="job-ai-label">AI draft — review before quoting, not sent to customer</span>
    ${costing?.summary ? `<div class="job-ai-summary">${escapeHtml(costing.summary)}</div>` : ''}
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
    <div class="job-actions">
      <button type="button" class="btn btn-sm job-add-line">+ Add line</button>
      <button type="button" class="btn btn-primary btn-sm job-save">Save changes</button>
      <button type="button" class="btn btn-sm job-copy">Copy quote text</button>
      <span class="job-save-status"></span>
    </div>
  `

  const costingSlot = card.querySelector('.job-costing-slot')
  const totalSlot = card.querySelector('.job-total-slot')

  let tableRef

  if (costing) {
    const built = buildCostingTable(costing)
    tableRef = built
    costingSlot.appendChild(built.table)
  } else {
    costingSlot.innerHTML = '<p class="job-no-costing">No AI draft available for this one — price manually.</p>'
    const built = buildCostingTable({ line_items: [] })
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
    totalSlot.innerHTML = `<div class="job-total">Total: $${money(total)}</div>`
  }

  card.addEventListener('input', (e) => {
    if (e.target.matches('.qty, .price')) refreshTotal()
  })
  refreshTotal()

  card.querySelector('.job-add-line').addEventListener('click', () => tableRef.addRow())

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

  card.querySelector('.job-copy').addEventListener('click', async () => {
    const rows = [...card.querySelectorAll('.job-costing-table tbody tr')].map(tr => ({
      description: tr.querySelector('.desc').value.trim(),
      qty: Number(tr.querySelector('.qty').value) || 0,
      sell_price: Number(tr.querySelector('.price').value) || 0
    }))
    const total = computeTotal(rows)
    const lines = rows.map(r => `${r.qty} x ${r.description} — $${money(r.sell_price)}`)
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
    result.requests.forEach(row => jobList.appendChild(renderCard(row)))
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
