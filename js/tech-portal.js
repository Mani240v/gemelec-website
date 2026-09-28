// Field portal: a technician standing on site enters the job, the office picks it up in
// /job-requests. Posts to the same /api/job-request as the customer form, so there is one
// pipeline, one price book and one dashboard rather than a parallel set to keep in step.
//
// Photo compression is duplicated from js/job-request.js rather than shared. The two pages
// load different scripts and there is no bundler in this repo, so sharing would mean a
// third file loaded by both — worth doing if a third caller ever appears, not for two.

// Sign-in lives in an HttpOnly cookie set by /api/staff-session (see api/_lib/staff-session.js),
// so the phone stays signed in for months and no script can read the code. CODE_KEY is only
// read now, to move a phone that signed in before 2026-09-29 onto the cookie; SIGNED_IN_KEY
// just lets the portal open instantly, and offline, without asking the server first.
const CODE_KEY = 'gemelec_tech_code'
const SIGNED_IN_KEY = 'gemelec_tech_signed_in'
const NAME_KEY = 'gemelec_tech_name'
const DRAFT_KEY = 'gemelec_tech_draft'

const MAX_PHOTOS = 5
const MAX_DIMENSION = 1600
const JPEG_QUALITY = 0.7

const gate = document.getElementById('tech-gate')
const app = document.getElementById('tech-app')
const gateError = document.getElementById('tech-gate-error')
const formError = document.getElementById('tech-form-error')
const codeInput = document.getElementById('tech-code')
const nameInput = document.getElementById('tech-name')
const unlockBtn = document.getElementById('tech-unlock')
const whoBtn = document.getElementById('tech-who-btn')
const form = document.getElementById('tech-form')
const sentBanner = document.getElementById('tech-sent-banner')
const sentTitle = document.getElementById('tech-sent-title')
const sentDetail = document.getElementById('tech-sent-detail')
const clearBtn = document.getElementById('tech-clear')
const review = document.getElementById('tech-review')
const reviewSend = document.getElementById('tech-review-send')
const reviewBack = document.getElementById('tech-review-back')
const reviewMore = document.getElementById('rv-more')
const photoInput = document.getElementById('t_photos')
const photoPreview = document.getElementById('t_photo_preview')
const descInput = document.getElementById('t_description')
const descCount = document.getElementById('t_desc_count')
const submitBtn = document.getElementById('tech-submit')
const commercialBox = document.getElementById('t_commercial')
const commercialFields = document.getElementById('t_commercial_fields')
const returningBox = document.getElementById('t_returning')

let compressedPhotos = []

// The request id of what was last sent from this form, or null for a fresh job. Set after a
// successful send, cleared by "Start a new job". Its only purpose is to let a re-send say
// which earlier job it belongs to, so the office can pair them up.
let lastRequestId = null

function showError(el, message) {
  el.textContent = message
  el.hidden = false
}

function clearError(el) {
  el.textContent = ''
  el.hidden = true
}

// ---------------------------------------------------------------- gate

function techName() {
  return localStorage.getItem(NAME_KEY) || ''
}

function enterApp() {
  gate.hidden = true
  app.hidden = false
  whoBtn.hidden = false
  whoBtn.textContent = techName()
  document.getElementById('tech-to-office').hidden = false
  restoreDraft()
  loadPriceBook()
}

async function unlock() {
  clearError(gateError)
  const code = codeInput.value.trim()
  const name = nameInput.value.trim()

  if (!code && !nameOnly) return showError(gateError, 'Enter the access code.')
  if (!name) return showError(gateError, 'Enter your name so the office knows who took the job.')

  unlockBtn.disabled = true
  unlockBtn.textContent = 'Checking...'
  try {
    const response = await fetch('/api/staff-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Name only when the phone is already signed in; the server just renames the session.
      body: JSON.stringify(code ? { password: code, name } : { name })
    })
    const result = await response.json().catch(() => ({}))
    if (response.status === 401 && nameOnly) {
      // The sign-in lapsed between opening and now, so the name alone won't do: bring the
      // code box back rather than say "Wrong code" about a box that isn't there.
      nameOnly = false
      codeInput.hidden = false
      const codeLabel = document.querySelector('label[for="tech-code"]')
      if (codeLabel) codeLabel.hidden = false
      throw new Error('Signed out on this phone. Enter the access code too.')
    }
    if (!response.ok || result.ok === false) {
      throw new Error(response.status === 401 ? 'Wrong code.' : (result.message || 'Wrong code.'))
    }
    // The server has set the sign-in cookie; the code itself is never stored on the phone.
    localStorage.setItem(NAME_KEY, name)
    localStorage.setItem(SIGNED_IN_KEY, '1')
    localStorage.removeItem(CODE_KEY)
    enterApp()
    if (window.gxPushRefresh) window.gxPushRefresh() // the notifications box (js/staff-push.js)
  } catch (error) {
    // A network failure and a wrong code must not read the same, or a tech with no signal
    // spends five minutes retyping a code that was right all along.
    const offline = !navigator.onLine
    showError(gateError, offline
      ? 'No signal — the code cannot be checked out here. Try again once you have a bar or two.'
      : (error.message || 'Wrong code.'))
  } finally {
    unlockBtn.disabled = false
    unlockBtn.textContent = 'Unlock'
  }
}

unlockBtn.addEventListener('click', unlock)
;[codeInput, nameInput].forEach(el => {
  el.addEventListener('keydown', e => { if (e.key === 'Enter') unlock() })
})

whoBtn.addEventListener('click', async () => {
  if (!confirm(`Signed in as ${techName()}. Sign out on this phone? This also signs out the job requests page here.`)) return
  // Stop this phone's enquiry notifications first, while the cookie still exists to
  // authorise it (js/staff-push.js).
  if (window.gxPushSignOut) await window.gxPushSignOut()
  // The cookie has to be cleared by the server. If that can't happen (no signal), don't
  // pretend: the next open would find the cookie and sign straight back in.
  try {
    const response = await fetch('/api/staff-session', { method: 'DELETE' })
    if (!response.ok) throw new Error('sign-out failed')
  } catch {
    alert('Could not sign out with no signal. Try again once you have a bar or two.')
    return
  }
  localStorage.removeItem(CODE_KEY)
  localStorage.removeItem(SIGNED_IN_KEY)
  localStorage.removeItem(NAME_KEY)
  location.reload()
})

// Back to the gate without losing anything: the name stays filled in and the job draft is
// still in localStorage, so it comes straight back after the code is entered again.
function signOutLocally(message) {
  try {
    localStorage.removeItem(CODE_KEY)
    localStorage.removeItem(SIGNED_IN_KEY)
  } catch {}
  app.hidden = true
  whoBtn.hidden = true
  document.getElementById('tech-to-office').hidden = true
  nameInput.value = techName()
  gate.hidden = false
  if (message) showError(gateError, message)
}

// ---------------------------------------------------------------- photos

function compressImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const img = new Image()
      img.onload = () => {
        let { width, height } = img
        if (width > height && width > MAX_DIMENSION) {
          height = Math.round((height * MAX_DIMENSION) / width)
          width = MAX_DIMENSION
        } else if (height > MAX_DIMENSION) {
          width = Math.round((width * MAX_DIMENSION) / height)
          height = MAX_DIMENSION
        }
        const canvas = document.createElement('canvas')
        canvas.width = width
        canvas.height = height
        canvas.getContext('2d').drawImage(img, 0, 0, width, height)
        const dataUrl = canvas.toDataURL('image/jpeg', JPEG_QUALITY)
        resolve({ mimeType: 'image/jpeg', base64: dataUrl.split(',')[1], preview: dataUrl })
      }
      img.onerror = () => reject(new Error('Could not read that image'))
      img.src = reader.result
    }
    reader.onerror = () => reject(new Error('Could not read that file'))
    reader.readAsDataURL(file)
  })
}

function renderPreviews() {
  photoPreview.innerHTML = ''
  compressedPhotos.forEach((photo, index) => {
    const wrap = document.createElement('div')
    wrap.className = 'job-photo-thumb'
    const img = document.createElement('img')
    img.src = photo.preview
    img.alt = `Photo ${index + 1}`
    const remove = document.createElement('button')
    remove.type = 'button'
    remove.className = 'job-photo-remove'
    remove.setAttribute('aria-label', `Remove photo ${index + 1}`)
    remove.textContent = '×'
    remove.addEventListener('click', () => {
      compressedPhotos.splice(index, 1)
      renderPreviews()
    })
    wrap.append(img, remove)
    photoPreview.appendChild(wrap)
  })
}

photoInput.addEventListener('change', async () => {
  clearError(formError)
  const files = [...photoInput.files]
  const room = MAX_PHOTOS - compressedPhotos.length

  if (room <= 0) {
    showError(formError, `That is already ${MAX_PHOTOS} photos — remove one first.`)
    photoInput.value = ''
    return
  }

  // Adds to what is there rather than replacing, so a tech can shoot two now and pick
  // three from the gallery afterwards without losing the first two.
  for (const file of files.slice(0, room)) {
    try {
      compressedPhotos.push(await compressImage(file))
    } catch (error) {
      console.error('Photo compression failed:', error)
    }
  }
  if (files.length > room) {
    showError(formError, `Only the first ${room} of those were added — ${MAX_PHOTOS} is the limit.`)
  }
  photoInput.value = ''
  renderPreviews()
})

// ---------------------------------------------------------------- items
//
// Mani: "I don't want to have to type every line item." The tech searches the price book
// (js/pricebook-picker.js) and taps items into a list; on send, that list becomes the job's
// costing on the dashboard in place of an AI draft (pickedCosting in api/job-request.js).
//
// Only the code and the quantity of each are sent. The server reads every description and
// price from its own copy of the price list, so the figures here are for the tech's eyes
// only. They are RRP, the list sell_price ex GST: any discount is Mani's call on the
// dashboard and never appears on a tech's phone.
//
// Optional in every direction. A phone holding an older cached tech.html has none of this
// markup, the picker script can fail to load, the price book can be out of reach (no
// signal); in all of those the job sends exactly as it did before, just without items.

const MAX_ITEMS = 40 // api/job-request.js ignores anything past the 40th
const MAX_ITEM_QTY = 500
const priceBook = window.GxPricebook || null
const itemSearch = document.getElementById('t_item_search')
const itemList = document.getElementById('t_items')
const itemsNote = document.getElementById('t_items_note')
const itemsOften = document.getElementById('t_items_often')
const itemsTotal = document.getElementById('t_items_total')
const itemsTotalValue = document.getElementById('t_items_total_value')
const itemsReady = Boolean(itemSearch && itemList && itemsNote && itemsOften && itemsTotal && itemsTotalValue)
const ITEMS_UNAVAILABLE = "Can't reach the price book right now (no signal?). Send the job anyway and put the items in the description."

// [{ code, description, price, qty }] in the order they were added. Kept in the draft with
// the descriptions and prices, so a restored list still reads properly with no signal.
let techItems = []
let lastAddedCode = ''

function rrp(value) {
  return `$${(Number(value) || 0).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

// `added` marks a pick's confirmation (green), which the next keystroke in the search clears;
// anything else here is a warning and stays until it no longer applies.
function showItemsNote(message, added = false) {
  if (!itemsReady) return
  itemsNote.textContent = message
  itemsNote.hidden = !message
  itemsNote.classList.toggle('is-added', Boolean(message) && added)
}

function clearAddedNote() {
  if (itemsReady && itemsNote.classList.contains('is-added')) showItemsNote('')
}

// Fetched when the portal opens, so the first letter typed already has a list, and again on
// focusing the search and on getting signal back. After a failure the picker only really
// retries once 30 seconds have passed, so this is not a request per tap.
function loadPriceBook() {
  if (!itemsReady || !priceBook) return
  priceBook.load().then(() => {
    showItemsNote('')
    refreshItemsFromPriceBook()
  }, () => showItemsNote(ITEMS_UNAVAILABLE))
}

// A list restored from the draft shows what was saved; once the price book is here, bring
// each line up to date with it. The chips need it loaded too.
function refreshItemsFromPriceBook() {
  let changed = false
  for (const line of techItems) {
    const item = priceBook.lookup(line.code)
    if (item && (item.code !== line.code || item.description !== line.description || item.price !== line.price)) {
      line.code = item.code
      line.description = item.description
      line.price = item.price
      changed = true
    }
  }
  if (changed) {
    renderItems()
    saveDraft()
  } else {
    renderOften()
  }
}

// A pick or a chip. Picking something already on the list adds one more of it.
//
// Every add is said in words under the search box (a role="status" line, so a screen reader
// hears it too). On a phone the keyboard can cover the line, its stepper and the total, and
// a pick that changed nothing visible invites a second tap "to make sure", which silently
// makes it two.
function addItem(item) {
  if (!item || !item.code) return
  let line = techItems.find(other => other.code === item.code)
  if (line) {
    if (line.qty >= MAX_ITEM_QTY) {
      showItemsNote(`${line.description || line.code} is already at ${MAX_ITEM_QTY}, the most one line can take.`)
      return
    }
    line.qty += 1
  } else if (techItems.length >= MAX_ITEMS) {
    showItemsNote(`${MAX_ITEMS} items is the most one job can take. Put anything else in the description.`)
    return
  } else {
    line = { code: item.code, description: item.description, price: Number(item.price) || 0, qty: 1 }
    techItems.push(line)
  }
  lastAddedCode = item.code
  showItemsNote(`Added: ${line.description || line.code}${line.qty > 1 ? ` (now ${line.qty})` : ''}`, true)
  renderItems()
  saveDraft()
}

function renderItems() {
  if (!itemsReady) return
  itemList.textContent = ''
  techItems.forEach(line => itemList.appendChild(itemRow(line)))
  itemList.hidden = !techItems.length
  updateItemsTotal()
  renderOften()
}

function updateItemsTotal() {
  const total = techItems.reduce((sum, line) => sum + line.qty * (Number(line.price) || 0), 0)
  itemsTotalValue.textContent = rrp(total)
  itemsTotal.hidden = !techItems.length
}

// "Often added with:" for the item added last, leaving out anything already on the list.
function renderOften() {
  if (!priceBook) return
  const onList = techItems.map(line => line.code)
  const base = onList.includes(lastAddedCode) ? lastAddedCode : onList[onList.length - 1]
  const suggestions = base ? priceBook.companionsFor(base, onList).slice(0, 6) : []
  priceBook.showCompanions(itemsOften, suggestions, item => addItem(item))
}

// Built from DOM nodes and textContent only: the descriptions are data, never HTML.
function itemRow(line) {
  const li = document.createElement('li')
  li.className = 'tech-item'

  const desc = document.createElement('span')
  desc.className = 'tech-item-desc'
  desc.textContent = line.description || line.code
  const meta = document.createElement('span')
  meta.className = 'tech-item-meta'
  const code = document.createElement('span')
  code.className = 'tech-item-code'
  code.textContent = line.code
  const each = document.createElement('span')
  each.textContent = `${rrp(line.price)} each`
  meta.append(code, each)

  const stepper = document.createElement('div')
  stepper.className = 'tech-qty'
  stepper.setAttribute('role', 'group')
  stepper.setAttribute('aria-label', `How many: ${line.description || line.code}`)
  const minus = document.createElement('button')
  minus.type = 'button'
  minus.className = 'tech-qty-btn'
  minus.textContent = '−'
  minus.setAttribute('aria-label', 'One fewer')
  const qty = document.createElement('input')
  qty.type = 'text'
  qty.className = 'tech-qty-input'
  qty.setAttribute('inputmode', 'numeric')
  qty.setAttribute('pattern', '[0-9]*')
  qty.setAttribute('autocomplete', 'off')
  qty.setAttribute('aria-label', 'Quantity')
  const plus = document.createElement('button')
  plus.type = 'button'
  plus.className = 'tech-qty-btn'
  plus.textContent = '+'
  plus.setAttribute('aria-label', 'One more')
  stepper.append(minus, qty, plus)

  const remove = document.createElement('button')
  remove.type = 'button'
  remove.className = 'tech-item-remove'
  remove.textContent = 'Remove'
  remove.setAttribute('aria-label', `Remove ${line.description || line.code}`)

  const controls = document.createElement('div')
  controls.className = 'tech-item-controls'
  controls.append(stepper, remove)
  li.append(desc, meta, controls)

  const showQty = () => {
    qty.value = String(line.qty)
    minus.disabled = line.qty <= 1
    plus.disabled = line.qty >= MAX_ITEM_QTY
  }
  const setQty = n => {
    line.qty = Math.min(MAX_ITEM_QTY, Math.max(1, n))
    showQty()
    updateItemsTotal()
    saveDraft()
  }
  showQty()

  minus.addEventListener('click', () => setQty(line.qty - 1))
  plus.addEventListener('click', () => setQty(line.qty + 1))
  // Typing 30 beats tapping + 29 times. Only a whole number from 1 up counts while typing;
  // leaving the box tidies it to what counted (blank, 0 or 2.5 go back, 900 becomes 500).
  qty.addEventListener('input', () => {
    const n = Number(qty.value)
    if (!qty.value.trim() || !Number.isInteger(n) || n < 1) return
    line.qty = Math.min(MAX_ITEM_QTY, n)
    minus.disabled = line.qty <= 1
    plus.disabled = line.qty >= MAX_ITEM_QTY
    updateItemsTotal()
    saveDraft()
  })
  qty.addEventListener('change', () => setQty(line.qty))
  // Enter in a text box submits the form, which opens the read-back. Here it means "done".
  qty.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault()
      qty.blur()
    }
  })
  remove.addEventListener('click', () => {
    techItems = techItems.filter(other => other !== line)
    clearAddedNote()
    renderItems()
    saveDraft()
  })
  return li
}

// From the draft. Checked like anything else read back from storage.
function itemsFromDraft(saved) {
  if (!Array.isArray(saved)) return []
  return saved
    .filter(line => line && typeof line.code === 'string' && line.code &&
      Number.isInteger(line.qty) && line.qty >= 1)
    .slice(0, MAX_ITEMS)
    .map(line => ({
      code: line.code,
      description: String(line.description || ''),
      price: Number(line.price) || 0,
      qty: Math.min(MAX_ITEM_QTY, line.qty)
    }))
}

if (itemsReady) {
  if (priceBook) {
    priceBook.attach(itemSearch, item => {
      // The picker has just put the description in the box; clear it for the next search.
      itemSearch.value = ''
      addItem(item)
      // On a touch screen, drop the keyboard: a pick leaves focus in the box (the list is
      // pressed without taking it), and the keyboard would go on covering the line just
      // added, the total and the "Often added with" chips. A mouse and keyboard keep focus,
      // ready for the next search.
      if (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) itemSearch.blur()
    }, {
      // This box never keeps free text (an unpicked search is not sent), so Return/Go adds
      // the top match: a phone has no arrow keys to highlight one with.
      enterPicksFirst: true,
      noMatchText: 'No match in the price book. Write it in the description above.',
      unavailableText: ITEMS_UNAVAILABLE
    })
    itemSearch.addEventListener('focus', loadPriceBook)
    window.addEventListener('online', loadPriceBook)
    // The last pick's "Added: ..." has done its job once the next search starts.
    itemSearch.addEventListener('input', clearAddedNote)
  } else {
    itemSearch.disabled = true
    showItemsNote(ITEMS_UNAVAILABLE)
  }
  // Never let Enter here submit the form. With matches showing, the picker has already added
  // the top one (or the one highlighted with the arrow keys); with none, it does nothing.
  itemSearch.addEventListener('keydown', e => {
    if (e.key === 'Enter') e.preventDefault()
  })
}

// ------------------------------------------------------- commercial toggle

function syncCommercial() {
  commercialFields.hidden = !commercialBox.checked
}
commercialBox.addEventListener('change', () => { syncCommercial(); saveDraft() })
returningBox.addEventListener('change', saveDraft)

// ---------------------------------------------------- jump to the office view

// Nothing to hand over any more. The sign-in cookie is shared by both pages, so a tech who
// has unlocked the portal lands straight in /job-requests. Until 2026-09-29 this copied the
// code into the dashboard's sessionStorage instead.
//
// When the two secrets differ (TECH_ACCESS_CODE set), the cookie carries the 'tech' role,
// the dashboard's API answers 401 and it shows its own login, as it always has.

// ---------------------------------------------------------------- draft

// Typed text survives a locked screen, a phone call, or the browser dropping the tab to
// reclaim memory — all of which happen constantly on a job. Photos are deliberately NOT
// saved: five base64 images would blow localStorage's quota and take the text down with it.
function saveDraft() {
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify({
      full_name: form.t_full_name.value,
      phone: form.t_phone.value,
      email: form.t_email.value,
      address: form.t_address.value,
      description: descInput.value,
      commercial: commercialBox.checked,
      returning: returningBox.checked,
      // These three must be here too. Restoring every field EXCEPT the billing block is
      // worse than restoring nothing: the form looks complete, so the tech does not notice
      // the gap and the office gets a commercial job with no one to invoice.
      site_contact: document.getElementById('t_site_contact').value,
      billing_address: document.getElementById('t_billing_address').value,
      billing_email: document.getElementById('t_billing_email').value,
      items: techItems
    }))
  } catch {}
}

function restoreDraft() {
  try {
    const draft = JSON.parse(localStorage.getItem(DRAFT_KEY) || '{}')
    if (draft.full_name) form.t_full_name.value = draft.full_name
    if (draft.phone) form.t_phone.value = draft.phone
    if (draft.email) form.t_email.value = draft.email
    if (draft.address) form.t_address.value = draft.address
    if (draft.description) descInput.value = draft.description
    commercialBox.checked = Boolean(draft.commercial)
    returningBox.checked = Boolean(draft.returning)
    if (draft.site_contact) document.getElementById('t_site_contact').value = draft.site_contact
    if (draft.billing_address) document.getElementById('t_billing_address').value = draft.billing_address
    if (draft.billing_email) document.getElementById('t_billing_email').value = draft.billing_email
    // Only when the draft has a list, like the fields above: a list still on screen after a
    // send (which clears the draft) is not wiped by coming back through the gate.
    if (Array.isArray(draft.items)) techItems = itemsFromDraft(draft.items)
  } catch {}
  syncCommercial()
  updateCount()
  renderItems()
}

function clearDraft() {
  try { localStorage.removeItem(DRAFT_KEY) } catch {}
}

function updateCount() {
  descCount.textContent = String(descInput.value.length)
}

descInput.addEventListener('input', () => { updateCount(); saveDraft() })
;['t_full_name', 't_phone', 't_email', 't_address',
  't_site_contact', 't_billing_address', 't_billing_email'].forEach(id => {
  document.getElementById(id).addEventListener('input', saveDraft)
})

// ---------------------------------------------------------------- submit

// Collects and validates, or returns null having shown the reason.
function collect() {
  clearError(formError)
  const fullName = form.t_full_name.value.trim()
  const phone = form.t_phone.value.trim()
  const description = descInput.value.trim()

  if (!fullName) { showError(formError, 'Customer name is needed.'); return null }
  if (!phone) { showError(formError, 'Phone number is needed.'); return null }
  if (!description) { showError(formError, 'Describe the job before sending.'); return null }

  return {
    fullName, phone, description,
    email: form.t_email.value.trim(),
    address: form.t_address.value.trim(),
    commercial: commercialBox.checked,
    returning: returningBox.checked,
    siteContact: document.getElementById('t_site_contact').value.trim(),
    billingAddress: document.getElementById('t_billing_address').value.trim(),
    billingEmail: document.getElementById('t_billing_email').value.trim(),
    items: techItems.map(line => ({ ...line }))
  }
}

function openReview(job) {
  document.getElementById('rv-name').textContent = job.fullName
  document.getElementById('rv-phone').textContent = job.phone
  document.getElementById('rv-address').textContent = job.address || 'not given'
  document.getElementById('rv-photos').textContent = compressedPhotos.length
    ? `${compressedPhotos.length} attached`
    : 'none attached'
  const flags = []
  flags.push(job.commercial ? 'Commercial' : 'Residential')
  if (job.returning) flags.push('returning — do not duplicate the contact')
  document.getElementById('rv-client').textContent = flags.join(' · ')
  renderReviewItems(job.items)
  const desc = document.getElementById('rv-description')
  desc.textContent = job.description
  review.hidden = false
  // Stop the form scrolling underneath the overlay on iOS.
  document.body.style.overflow = 'hidden'

  // Measured AFTER the overlay is shown: a hidden element reports zero height, so doing this
  // any earlier decides every description is short. Clamped rather than left as a scroll box
  // because a scrollable panel inside a modal gives no sign there is more to read, and the
  // whole point of this screen is that the tech reads all of it.
  desc.classList.remove('is-expanded')
  const clipped = desc.scrollHeight > desc.clientHeight + 4
  reviewMore.hidden = !clipped
  reviewMore.textContent = 'Read all of it'

  reviewSend.focus()
}

// The picked items on the read-back: these become the office's costing, so they get the
// same second look as the words. Stands down on an older cached tech.html without the markup.
function renderReviewItems(items) {
  const count = document.getElementById('rv-items-count')
  const wrap = document.getElementById('rv-items-wrap')
  const list = document.getElementById('rv-items')
  if (!count || !wrap || !list) return
  count.textContent = items.length
    ? `${items.length} ${items.length === 1 ? 'line' : 'lines'}, listed below`
    : 'none added'
  list.textContent = ''
  let total = 0
  for (const line of items) {
    const lineTotal = line.qty * (Number(line.price) || 0)
    total += lineTotal
    const li = document.createElement('li')
    const what = document.createElement('span')
    what.textContent = `${line.qty} × ${line.description || line.code}`
    const cost = document.createElement('span')
    cost.textContent = rrp(lineTotal)
    li.append(what, cost)
    list.appendChild(li)
  }
  if (items.length) {
    const li = document.createElement('li')
    li.className = 'tech-review-items-total'
    const label = document.createElement('span')
    label.textContent = 'Total (RRP, ex GST)'
    const cost = document.createElement('span')
    cost.textContent = rrp(total)
    li.append(label, cost)
    list.appendChild(li)
  }
  wrap.hidden = !items.length
}

function closeReview() {
  review.hidden = true
  document.body.style.overflow = ''
}

// Submitting only opens the read-back. Nothing is sent until the tech confirms in there —
// the estimate is built from these words, so a deliberate second look is the cheapest place
// to catch a wrong one.
form.addEventListener('submit', (e) => {
  e.preventDefault()
  const job = collect()
  if (job) openReview(job)
})

reviewMore.addEventListener('click', () => {
  const desc = document.getElementById('rv-description')
  const expanded = desc.classList.toggle('is-expanded')
  reviewMore.textContent = expanded ? 'Show less' : 'Read all of it'
})

reviewBack.addEventListener('click', () => {
  closeReview()
  descInput.focus()
})

// Tapping the backdrop is "go back", never "send" — the destructive reading of a stray tap
// must be the harmless one.
review.addEventListener('click', (e) => { if (e.target === review) closeReview() })

reviewSend.addEventListener('click', async () => {
  const job = collect()
  if (!job) { closeReview(); return }

  const isUpdate = Boolean(lastRequestId)
  const payload = {
    company_website: '',
    full_name: job.fullName,
    phone: job.phone,
    email: job.email,
    job_address: job.address,
    // A re-send is a separate row that names the job it belongs to, rather than an edit of
    // the original. The office may already have priced or quoted the first one, and silently
    // overwriting a row someone is working from is the one outcome worth ruling out. Two
    // clearly paired cards are a human's job to reconcile; a lost edit is nobody's.
    description: isUpdate
      ? `[UPDATE to ${lastRequestId} — the tech added this after sending]\n\n${job.description}`
      : job.description,
    photos: compressedPhotos.map(p => ({ mimeType: p.mimeType, base64: p.base64 })),
    client_type: job.commercial ? 'commercial' : 'residential',
    returning_customer: job.returning,
    site_contact: job.commercial ? job.siteContact : '',
    billing_address: job.commercial ? job.billingAddress : '',
    billing_email: job.commercial ? job.billingEmail : '',
    source: isUpdate
      ? `On site — ${techName()} · UPDATE to ${lastRequestId}`
      : `On site — ${techName()}`,
    page_url: window.location.href
  }
  // Codes and quantities only: the server prices them from its own price list. Left out
  // altogether when there are none, so a job without items posts exactly what it always did.
  if (job.items.length) {
    payload.tech_items = job.items.map(line => ({ code: line.code, qty: line.qty }))
  }

  reviewSend.disabled = true
  reviewSend.textContent = 'Sending...'

  try {
    const response = await fetch('/api/job-request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
    const result = await response.json().catch(() => ({}))
    if (!response.ok || result.ok === false) {
      throw new Error(result.message || 'That could not be sent.')
    }

    // Deliberately NOT reset. The tech keeps everything on screen so they can add the thing
    // they forgot and send again, which is the whole point of leaving the form up.
    lastRequestId = result.requestId || lastRequestId
    clearDraft()
    closeReview()
    markSent(job.fullName, isUpdate)
  } catch (error) {
    closeReview()
    showError(formError, !navigator.onLine
      ? 'No signal. Nothing was sent, and your text is still here — try again once you have a bar or two.'
      : (error.message || 'Could not send. Try again, or ring the office.'))
  } finally {
    reviewSend.disabled = false
    reviewSend.textContent = "Yes — it's accurate, send it"
  }
})

function markSent(name, wasUpdate) {
  const time = new Date().toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit' })
  sentTitle.textContent = wasUpdate ? `Update sent at ${time}` : `Sent to the office at ${time}`
  sentDetail.textContent = `${name} — everything is still here. Forgot something? Add it and send again; the office gets it linked to the first one.`
  sentBanner.hidden = false
  submitBtn.textContent = 'Send update to office'
  window.scrollTo({ top: 0, behavior: 'smooth' })
}

clearBtn.addEventListener('click', () => {
  if (!confirm('Clear this job and start a fresh one?')) return
  lastRequestId = null
  form.reset()
  compressedPhotos = []
  renderPreviews()
  techItems = []
  lastAddedCode = ''
  clearAddedNote()
  renderItems()
  updateCount()
  clearDraft()
  clearError(formError)
  sentBanner.hidden = true
  submitBtn.textContent = 'Send to office'
  form.t_full_name.focus()
})

// ------------------------------------------------------ address autocomplete

// Called by the Maps script tag in tech.html once it loads. Global on purpose — that is how
// the `callback` URL param invokes it. Named differently from the customer form's
// initAddressAutocomplete because that one looks for #job_address, which does not exist here.
function initTechAutocomplete() {
  if (!window.google?.maps?.places) return

  for (const id of ['t_address', 't_billing_address']) {
    const input = document.getElementById(id)
    if (!input) continue

    const autocomplete = new google.maps.places.Autocomplete(input, {
      componentRestrictions: { country: 'au' },
      // formatted_address only. Asking for more fields costs more per lookup and nothing
      // downstream reads anything else.
      fields: ['formatted_address'],
      types: ['address']
    })

    autocomplete.addListener('place_changed', () => {
      const place = autocomplete.getPlace()
      if (!place?.formatted_address) return
      input.value = place.formatted_address
      // Setting .value from script fires no input event, so the draft autosave would never
      // see a picked address — the tech taps a suggestion, gets a phone call, and comes back
      // to a form with the address blank while everything they typed by hand survived.
      // Saving directly closes that.
      saveDraft()
    })
  }
}

// ---------------------------------------------------------------- add to home screen
//
// Techs use this all day, so it should live on the home screen like an app. Android Chrome
// fires beforeinstallprompt once the page is installable (manifest + 192/512 icons + service
// worker), and that event is the only way to offer a one-tap Install button. iPhone has no
// such event or API: Safari installs only from its own Share menu, so there the box lists
// the taps instead. Browsers that never fire the event (Samsung Internet, Firefox) get the
// menu steps. Hidden when already running installed, and for good once dismissed here.
//
// It runs after boot and stands down if its markup is missing. A phone can still hold a
// cached tech.html from before this box existed (the v1 service worker served its cache on
// any network failure) next to a fresh copy of this script; that phone must still get a
// working portal, just without the prompt. So nothing here may throw on a missing element.

const INSTALL_DISMISSED_KEY = 'gemelec_tech_install_dismissed'
const installBox = document.getElementById('tech-install')
const installBtn = document.getElementById('tech-install-btn')
const installIosSteps = document.getElementById('tech-install-ios')
const installMenuSteps = document.getElementById('tech-install-menu')
const installDismissBtn = document.getElementById('tech-install-dismiss')
let installPrompt = null

function runningInstalled() {
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true
}

function installDismissed() {
  try { return localStorage.getItem(INSTALL_DISMISSED_KEY) === '1' } catch { return false }
}

function isIOS() {
  // iPadOS reports itself as a Mac; the touch points give it away.
  return /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
}

// mode: 'button' (Android one-tap), 'ios' (Share-menu steps) or 'menu' (browser-menu steps)
function showInstall(mode) {
  if (runningInstalled() || installDismissed()) return
  installIosSteps.hidden = mode !== 'ios'
  installMenuSteps.hidden = mode !== 'menu'
  installBtn.hidden = mode !== 'button'
  installBox.hidden = false
}

function setUpInstallPrompt() {
  if (!installBox || !installBtn || !installIosSteps || !installMenuSteps || !installDismissBtn) return

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault()
    installPrompt = e
    showInstall('button')
  })

  installBtn.addEventListener('click', async () => {
    if (!installPrompt) return
    const prompt = installPrompt
    installPrompt = null // the event can only be used once
    prompt.prompt()
    const choice = await prompt.userChoice.catch(() => null)
    if (choice && choice.outcome === 'accepted') installBox.hidden = true
    else showInstall('menu')
  })

  window.addEventListener('appinstalled', () => { installBox.hidden = true })

  installDismissBtn.addEventListener('click', () => {
    installBox.hidden = true
    try { localStorage.setItem(INSTALL_DISMISSED_KEY, '1') } catch {}
  })

  if (isIOS()) {
    showInstall('ios')
  } else if (window.matchMedia('(pointer: coarse)').matches) {
    // Give Chrome a moment to decide the page is installable before falling back to the steps.
    setTimeout(() => { if (!installPrompt && installBox.hidden) showInstall('menu') }, 4000)
  }
}

// ---------------------------------------------------------------- boot
//
// A phone that has signed in before opens straight into the app from localStorage, with no
// round trip, so the portal still opens in a basement with no signal. The cookie is checked
// in the background, and only a definite 401 (code changed, or 180 days unused) sends the
// tech back to the gate. A phone with nothing in localStorage asks the server first, because
// iPhone Safari wipes localStorage after a week unvisited but leaves the cookie alone.

function signedInHere() {
  return Boolean(techName() && (localStorage.getItem(SIGNED_IN_KEY) === '1' || localStorage.getItem(CODE_KEY)))
}

// Confirms the cookie, and moves a phone from before the cookie existed onto one: that phone
// still holds the code in localStorage, so sign in with it once and then forget it.
async function confirmSignIn() {
  const legacyCode = localStorage.getItem(CODE_KEY)
  let response
  try {
    response = legacyCode
      ? await fetch('/api/staff-session', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: legacyCode, name: techName() })
        })
      : await fetch('/api/staff-session', { cache: 'no-store' })
  } catch {
    return // no signal: stay in, and check again next time
  }
  if (response.ok) {
    try {
      localStorage.setItem(SIGNED_IN_KEY, '1')
      localStorage.removeItem(CODE_KEY)
    } catch {}
  } else if (response.status === 401) {
    signOutLocally('This phone has been signed out, either because the access code changed or because someone signed out on the job requests page. Enter the code to carry on. Your job draft is still here.')
  }
  // Anything else (a 5xx, the server not set up): leave the tech in and try again next open.
}

// Bounded: on one bar of signal an unanswered fetch can hang for a minute, and until it
// settles neither the gate nor the app is showing. Six seconds, then the gate.
async function signInFromCookie() {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 6000)
  try {
    const response = await fetch('/api/staff-session', { cache: 'no-store', signal: controller.signal })
    const result = await response.json().catch(() => ({}))
    if (response.ok && result.ok && result.name) {
      localStorage.setItem(NAME_KEY, result.name)
      localStorage.setItem(SIGNED_IN_KEY, '1')
      enterApp()
      return
    }
    if (response.ok && result.ok) askNameOnly() // signed in (say, on the dashboard) but no name yet
  } catch {
  } finally {
    clearTimeout(timer)
  }
  gate.hidden = false
}

// Signed in already, so only the name is missing: hide the code box rather than make
// someone retype a password the phone has already proved.
let nameOnly = false
function askNameOnly() {
  nameOnly = true
  codeInput.hidden = true
  const codeLabel = document.querySelector('label[for="tech-code"]')
  if (codeLabel) codeLabel.hidden = true
}

if (signedInHere()) {
  enterApp()
  confirmSignIn()
} else {
  signInFromCookie()
}

// After boot on purpose: whatever happens in here, the portal itself has already opened.
setUpInstallPrompt()
