// Field portal: a technician standing on site enters the job, the office picks it up in
// /job-requests. Posts to the same /api/job-request as the customer form, so there is one
// pipeline, one price book and one dashboard rather than a parallel set to keep in step.
//
// Photo compression is duplicated from js/job-request.js rather than shared. The two pages
// load different scripts and there is no bundler in this repo, so sharing would mean a
// third file loaded by both — worth doing if a third caller ever appears, not for two.

const CODE_KEY = 'gemelec_tech_code'
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
}

async function unlock() {
  clearError(gateError)
  const code = codeInput.value.trim()
  const name = nameInput.value.trim()

  if (!code) return showError(gateError, 'Enter the access code.')
  if (!name) return showError(gateError, 'Enter your name so the office knows who took the job.')

  unlockBtn.disabled = true
  unlockBtn.textContent = 'Checking...'
  try {
    const response = await fetch('/api/tech-auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code })
    })
    const result = await response.json().catch(() => ({}))
    if (!response.ok || result.ok === false) {
      throw new Error(result.message || 'Wrong code.')
    }
    localStorage.setItem(CODE_KEY, code)
    localStorage.setItem(NAME_KEY, name)
    shareCredentialWithDashboard()
    enterApp()
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

whoBtn.addEventListener('click', () => {
  if (!confirm(`Signed in as ${techName()}. Sign out on this phone?`)) return
  localStorage.removeItem(CODE_KEY)
  localStorage.removeItem(NAME_KEY)
  location.reload()
})

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

// ------------------------------------------------------- commercial toggle

function syncCommercial() {
  commercialFields.hidden = !commercialBox.checked
}
commercialBox.addEventListener('change', () => { syncCommercial(); saveDraft() })
returningBox.addEventListener('change', saveDraft)

// ---------------------------------------------------- jump to the office view

// The dashboard reads its password from sessionStorage; the portal keeps the same secret in
// localStorage. Copying it across means a tech who has unlocked the portal lands straight in
// /job-requests instead of logging in twice, and the two screens feel like one app.
//
// Harmless when the two secrets differ (TECH_ACCESS_CODE set): the dashboard gets a 401,
// clears it and shows its own login exactly as it would have anyway.
function shareCredentialWithDashboard() {
  try {
    const code = localStorage.getItem(CODE_KEY)
    if (code) sessionStorage.setItem('gemelec_dashboard_password', code)
  } catch {}
}

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
      billing_email: document.getElementById('t_billing_email').value
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
  } catch {}
  syncCommercial()
  updateCount()
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
    billingEmail: document.getElementById('t_billing_email').value.trim()
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
  updateCount()
  clearDraft()
  clearError(formError)
  sentBanner.hidden = true
  submitBtn.textContent = 'Send to office'
  form.t_full_name.focus()
})

// ---------------------------------------------------------------- boot

if (localStorage.getItem(CODE_KEY) && techName()) {
  shareCredentialWithDashboard()
  enterApp()
} else {
  gate.hidden = false
}
