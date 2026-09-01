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
const successPanel = document.getElementById('tech-success')
const successDetail = document.getElementById('tech-success-detail')
const anotherBtn = document.getElementById('tech-another')
const photoInput = document.getElementById('t_photos')
const photoPreview = document.getElementById('t_photo_preview')
const descInput = document.getElementById('t_description')
const descCount = document.getElementById('t_desc_count')
const submitBtn = document.getElementById('tech-submit')

let compressedPhotos = []

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
      description: descInput.value
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
  } catch {}
  updateCount()
}

function clearDraft() {
  try { localStorage.removeItem(DRAFT_KEY) } catch {}
}

function updateCount() {
  descCount.textContent = String(descInput.value.length)
}

descInput.addEventListener('input', () => { updateCount(); saveDraft() })
;['t_full_name', 't_phone', 't_email', 't_address'].forEach(id => {
  document.getElementById(id).addEventListener('input', saveDraft)
})

// ---------------------------------------------------------------- submit

form.addEventListener('submit', async (e) => {
  e.preventDefault()
  clearError(formError)

  const fullName = form.t_full_name.value.trim()
  const phone = form.t_phone.value.trim()
  const description = descInput.value.trim()

  if (!fullName) return showError(formError, 'Customer name is needed.')
  if (!phone) return showError(formError, 'Phone number is needed.')
  if (!description) return showError(formError, 'Describe the job before sending.')

  const payload = {
    company_website: '',
    full_name: fullName,
    phone,
    email: form.t_email.value.trim(),
    job_address: form.t_address.value.trim(),
    description,
    photos: compressedPhotos.map(p => ({ mimeType: p.mimeType, base64: p.base64 })),
    // Carried in the existing source column rather than a new one: adding a field means
    // touching HEADERS, the row object and the sheet's own header row, and "where did this
    // come from" is exactly what source is for.
    source: `On site — ${techName()}`,
    page_url: window.location.href
  }

  submitBtn.disabled = true
  submitBtn.textContent = 'Sending...'

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

    clearDraft()
    form.reset()
    compressedPhotos = []
    renderPreviews()
    updateCount()
    form.hidden = true
    successPanel.hidden = false
    successDetail.textContent = compressedPhotos.length
      ? `${fullName} is with the office.`
      : `${fullName} is with the office. The pricing lands in a minute or so.`
    window.scrollTo({ top: 0, behavior: 'smooth' })
  } catch (error) {
    showError(formError, !navigator.onLine
      ? 'No signal. Your text is saved on this phone — hit send again once you have signal.'
      : (error.message || 'Could not send. Try again, or ring the office.'))
  } finally {
    submitBtn.disabled = false
    submitBtn.textContent = 'Send to office'
  }
})

anotherBtn.addEventListener('click', () => {
  successPanel.hidden = true
  form.hidden = false
  form.t_full_name.focus()
})

// ---------------------------------------------------------------- boot

if (localStorage.getItem(CODE_KEY) && techName()) {
  enterApp()
} else {
  gate.hidden = false
}
