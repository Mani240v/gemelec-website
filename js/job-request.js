// Job request form: photo compression + submit handler.
// Shared by both contact.html and job-request.html — same form id, same fields.
//
// Keep this file to ES2017 syntax: no ?. or ??, no object spread, no Promise#finally.
// One newer token makes the whole file a parse error on older iPhones (iOS 12 and
// earlier) and Chrome before 80, and then no submit handler is attached at all.

const MAX_PHOTOS = 5
const MAX_DIMENSION = 1600
const JPEG_QUALITY = 0.7

// Vercel turns away a request body over 4.5 MB with a non-JSON 413 before
// api/job-request.js ever runs. Photos travel as base64 inside the JSON, a third bigger
// than the JPEG itself, so five busy 1600px shots can get there. Past this total the
// photos are re-encoded smaller, one step at a time, leaving room for the other fields.
const MAX_PHOTO_PAYLOAD = 3.8 * 1024 * 1024
const SHRINK_STEPS = [
  { maxDimension: 1280, quality: 0.6 },
  { maxDimension: 1024, quality: 0.5 }
]

const WHATSAPP_URL = 'https://wa.me/61498351351?text=Hi%20Gemelec%2C%20I%27d%20like%20to%20get%20a%20quote'

function compressImage(file, maxDimension = MAX_DIMENSION, quality = JPEG_QUALITY) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const img = new Image()
      img.onload = () => {
        let { width, height } = img
        if (width > height && width > maxDimension) {
          height = Math.round((height * maxDimension) / width)
          width = maxDimension
        } else if (height > maxDimension) {
          width = Math.round((width * maxDimension) / height)
          height = maxDimension
        }
        const canvas = document.createElement('canvas')
        canvas.width = width
        canvas.height = height
        canvas.getContext('2d').drawImage(img, 0, 0, width, height)
        const dataUrl = canvas.toDataURL('image/jpeg', quality)
        const base64 = dataUrl.split(',')[1]
        // A canvas the browser could not allocate comes back as "data:," with no image.
        if (!base64) return reject(new Error('Could not read that photo.'))
        resolve({ dataUrl, mimeType: 'image/jpeg', base64 })
      }
      img.onerror = () => reject(new Error('Could not read that photo.'))
      img.src = reader.result
    }
    reader.onerror = () => reject(new Error('Could not read that photo.'))
    reader.readAsDataURL(file)
  })
}

const jobRequestForm = document.getElementById('job-request-form')

if (jobRequestForm) {
  const successMsg = document.getElementById('form-success')
  const errorMsg = document.getElementById('form-error')
  const photosInput = document.getElementById('photos')
  const photoPreview = document.getElementById('photo-preview')
  const photosHelp = document.getElementById('photos-help')
  const photosHelpDefault = photosHelp ? photosHelp.textContent : ''
  const submitButton = jobRequestForm.querySelector('button[type="submit"]')
  const submitLabel = submitButton ? submitButton.textContent : ''

  let compressedPhotos = []
  // The batch of photos still being compressed, or null. A later selection queues behind
  // it, and the submit handler waits on it, so tapping Send early cannot leave photos out.
  let compressing = null
  // Bumped when the list is cleared after a send, so a batch still in flight drops its results.
  let photoGeneration = 0
  // Tallied across queued batches and reported once the queue is empty.
  let unreadCount = 0
  let overLimitCount = 0
  let submitting = false

  function updateSubmitButton() {
    if (!submitButton) return
    submitButton.disabled = submitting || Boolean(compressing)
    if (submitting) submitButton.textContent = 'Sending...'
    else if (compressing) submitButton.textContent = 'Adding photos...'
    else submitButton.textContent = submitLabel
  }

  function showPhotoStatus() {
    if (!photosHelp) return
    const parts = []
    if (compressedPhotos.length) {
      parts.push(`${compressedPhotos.length} of ${MAX_PHOTOS} photos attached.`)
    }
    if (unreadCount === 1) {
      parts.push("1 photo couldn't be read. Try a screenshot of it instead.")
    } else if (unreadCount > 1) {
      parts.push(`${unreadCount} photos couldn't be read. Try screenshots of them instead.`)
    }
    if (overLimitCount) {
      parts.push(`The limit is ${MAX_PHOTOS}, so ${overLimitCount} ${overLimitCount === 1 ? 'was' : 'were'} left off.`)
    }
    unreadCount = 0
    overLimitCount = 0
    photosHelp.textContent = parts.length ? parts.join(' ') : photosHelpDefault
  }

  function removePhoto(photo) {
    const position = compressedPhotos.indexOf(photo)
    if (position === -1) return
    compressedPhotos.splice(position, 1)
    renderPreviews()
    if (!compressing) showPhotoStatus()

    // renderPreviews rebuilt the buttons, so the one that had focus is gone. Hand focus
    // to the photo that slid into its place (or the new last one), else to the picker.
    const buttons = photoPreview.querySelectorAll('.job-photo-remove')
    const next = buttons[Math.min(position, buttons.length - 1)]
    if (next) next.focus()
    else if (photosInput) photosInput.focus()
  }

  function renderPreviews() {
    if (!photoPreview) return
    photoPreview.innerHTML = ''
    compressedPhotos.forEach((photo, index) => {
      const thumb = document.createElement('div')
      thumb.className = 'job-photo-thumb'

      const img = document.createElement('img')
      img.src = photo.dataUrl
      img.alt = `Job photo ${index + 1}`

      const removeBtn = document.createElement('button')
      removeBtn.type = 'button'
      removeBtn.className = 'job-photo-remove'
      removeBtn.setAttribute('aria-label', `Remove photo ${index + 1}`)
      removeBtn.textContent = '×'
      removeBtn.addEventListener('click', () => removePhoto(photo))

      thumb.appendChild(img)
      thumb.appendChild(removeBtn)
      photoPreview.appendChild(thumb)
    })
  }

  async function addPhotos(files, generation) {
    for (const file of files) {
      if (generation !== photoGeneration) return
      if (compressedPhotos.length >= MAX_PHOTOS) {
        overLimitCount++
        continue
      }
      try {
        const photo = await compressImage(file)
        if (generation !== photoGeneration) return
        // Kept so the photo can be re-encoded from the original if the send is too big.
        photo.file = file
        compressedPhotos.push(photo)
      } catch (error) {
        console.error('Photo compression failed:', error)
        unreadCount++
      }
    }
    renderPreviews()
  }

  function queuePhotos(files) {
    const generation = photoGeneration
    const batch = (compressing || Promise.resolve())
      .then(() => addPhotos(files, generation))
      .catch(error => console.error('Adding photos failed:', error))
    compressing = batch
    if (photosHelp) photosHelp.textContent = 'Compressing photos...'
    updateSubmitButton()

    batch.then(() => {
      if (compressing !== batch) return // another selection is queued behind this one
      compressing = null
      // Cleared so choosing the same photo again, e.g. after removing it, still fires change.
      if (photosInput) photosInput.value = ''
      showPhotoStatus()
      updateSubmitButton()
    })
  }

  async function photosReady() {
    // A selection made while waiting queues another batch, so wait until none is left.
    while (compressing) await compressing
  }

  function photoPayloadSize() {
    return compressedPhotos.reduce((total, photo) => total + photo.base64.length, 0)
  }

  async function fitPhotosToLimit() {
    for (const step of SHRINK_STEPS) {
      if (photoPayloadSize() <= MAX_PHOTO_PAYLOAD) return
      for (const photo of compressedPhotos.slice()) {
        if (!photo.file) continue
        try {
          const smaller = await compressImage(photo.file, step.maxDimension, step.quality)
          if (smaller.base64.length < photo.base64.length) {
            photo.dataUrl = smaller.dataUrl
            photo.base64 = smaller.base64
          }
        } catch (error) {
          console.error('Photo re-compression failed:', error)
        }
      }
    }
    // Still over after the last step: send anyway. A 413 gets its own message below.
  }

  // Marks a message as written for the customer. Anything else that throws in the submit
  // handler (fetch's "Failed to fetch" / "Load failed") is browser jargon and is not shown.
  function customerError(message) {
    const error = new Error(message)
    error.forCustomer = true
    return error
  }

  // Built from DOM nodes, never innerHTML: `message` can come from the server. The tel:
  // and wa.me links are counted as leads by the delegated handler in js/main.js.
  function showFailure(message) {
    if (!errorMsg) return
    errorMsg.textContent = ''

    const summary = document.createElement('p')
    summary.textContent = message || "Sorry, that didn't go through."

    const callLink = document.createElement('a')
    callLink.href = 'tel:0498351351'
    callLink.textContent = '0498 351 351'

    const whatsappLink = document.createElement('a')
    whatsappLink.href = WHATSAPP_URL
    whatsappLink.target = '_blank'
    whatsappLink.rel = 'noopener'
    whatsappLink.textContent = 'WhatsApp'

    const fallback = document.createElement('p')
    fallback.appendChild(document.createTextNode('Your details are still here. Try again, or call '))
    fallback.appendChild(callLink)
    fallback.appendChild(document.createTextNode(' or message us on '))
    fallback.appendChild(whatsappLink)
    fallback.appendChild(document.createTextNode('.'))

    errorMsg.appendChild(summary)
    errorMsg.appendChild(fallback)
    errorMsg.style.display = 'block'
    errorMsg.scrollIntoView({ behavior: 'smooth', block: 'center' })
    if (!errorMsg.hasAttribute('tabindex')) errorMsg.setAttribute('tabindex', '-1')
    if (typeof errorMsg.focus === 'function') errorMsg.focus()
  }

  if (photosInput) {
    photosInput.addEventListener('change', () => {
      const files = Array.from(photosInput.files || [])
      if (files.length) queuePhotos(files)
    })
  }

  jobRequestForm.addEventListener('submit', async (e) => {
    e.preventDefault()
    if (submitting) return

    if (successMsg) successMsg.style.display = 'none'
    if (errorMsg) errorMsg.style.display = 'none'

    if (jobRequestForm.reportValidity && !jobRequestForm.reportValidity()) {
      const firstInvalid = jobRequestForm.querySelector(':invalid')
      if (firstInvalid && typeof firstInvalid.focus === 'function') firstInvalid.focus()
      return
    }

    submitting = true
    updateSubmitButton()

    try {
      // Photos still compressing would otherwise be missing from the payload.
      await photosReady()
      await fitPhotosToLimit()

      const fullName = `${jobRequestForm.first_name.value} ${jobRequestForm.last_name.value}`.trim()

      const payload = {
        // Read defensively: a stale cached page may still carry the old company_website
        // input, and a hard .value on a missing field would throw and fail every send.
        gx_check: (jobRequestForm.gx_check || jobRequestForm.company_website || { value: '' }).value,
        full_name: fullName,
        phone: jobRequestForm.phone.value,
        email: jobRequestForm.email.value,
        job_address: jobRequestForm.job_address.value,
        description: jobRequestForm.description.value,
        photos: compressedPhotos.map(photo => ({ mimeType: photo.mimeType, base64: photo.base64 })),
        source: 'website',
        page_url: window.location.href
      }

      const response = await fetch('/api/job-request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      })
      const result = await response.json().catch(() => ({}))

      // Success is only ever {ok: true} from our own function. A 200 whose body is not
      // that JSON came from something else in the path, and the lead was not recorded.
      if (!response.ok || !result || result.ok !== true) {
        if (response.status === 413) {
          throw customerError('Your photos are too large to send. Remove one or two and send again.')
        }
        throw customerError(result && typeof result.message === 'string' ? result.message : '')
      }

      jobRequestForm.reset()
      compressedPhotos = []
      photoGeneration++
      renderPreviews()
      jobRequestForm.style.display = 'none'

      // Send the visitor to a real confirmation URL rather than revealing an inline
      // banner. /thank-you is what analytics can count as a conversion — an inline
      // div never changes the URL, so there is nothing to fire a goal on.
      // The #form-success banner below is the fallback if navigation is blocked.
      if (successMsg) successMsg.style.display = 'block'

      // One-shot token consumed by the generate_lead block in js/main.js, so the
      // conversion counts a real submission rather than any arrival at the page.
      // Written only after the POST succeeded — a failed send must not look like
      // a lead. Storage being unavailable is not worth failing the redirect over.
      try { sessionStorage.setItem('gx_pending_lead', '1') } catch (err) {}

      window.location.assign('/thank-you')
    } catch (error) {
      showFailure(error && error.forCustomer ? error.message : '')
    } finally {
      submitting = false
      updateSubmitButton()
    }
  })
}

// Google Places address autocomplete, loaded on demand. The Maps script is ~390 KB
// (1.4 MB unpacked) for an optional field, so it is fetched the first time someone goes
// to use the address box rather than on every visit to the form pages.
// Key restricted by HTTP referrer to gemelec.com.au in Google Cloud Console; see VERCEL_SETUP.md.
const MAPS_SCRIPT_SRC = 'https://maps.googleapis.com/maps/api/js?key=AIzaSyCqpQOGjoHUGCe1EJeJVBETvXI1Y02yVYM&libraries=places&loading=async&callback=initAddressAutocomplete'
let mapsScriptRequested = false
let placesImportTried = false

function loadAddressAutocomplete() {
  if (mapsScriptRequested) return
  mapsScriptRequested = true
  const script = document.createElement('script')
  script.src = MAPS_SCRIPT_SRC
  script.async = true
  document.head.appendChild(script)
}

const jobAddressInput = document.getElementById('job_address')
if (jobAddressInput) {
  jobAddressInput.addEventListener('focus', loadAddressAutocomplete)
  jobAddressInput.addEventListener('pointerdown', loadAddressAutocomplete)
  jobAddressInput.addEventListener('touchstart', loadAddressAutocomplete, { passive: true })
}

// Called by the Maps script once it has loaded (injected by loadAddressAutocomplete above).
// Global on purpose — that's how the Maps API's `callback` URL param invokes it.
function initAddressAutocomplete() {
  const addressInput = document.getElementById('job_address')
  if (!addressInput || !(window.google && window.google.maps)) return

  if (!window.google.maps.places) {
    // libraries=places should be in place before the callback runs. If it is not,
    // importLibrary is the documented way to fetch it. Tried once, so this cannot loop.
    if (!placesImportTried && typeof window.google.maps.importLibrary === 'function') {
      placesImportTried = true
      window.google.maps.importLibrary('places').then(initAddressAutocomplete, error => {
        console.error('Places library failed to load:', error)
      })
    }
    return
  }

  const autocomplete = new google.maps.places.Autocomplete(addressInput, {
    componentRestrictions: { country: 'au' },
    fields: ['formatted_address'],
    types: ['address']
  })

  autocomplete.addListener('place_changed', () => {
    const place = autocomplete.getPlace()
    if (place && place.formatted_address) addressInput.value = place.formatted_address
  })

  // The script arrives after the first tap, so the customer may already be typing.
  // Replaying an input event lets the widget offer suggestions for what is there.
  if (addressInput.value && document.activeElement === addressInput) {
    addressInput.dispatchEvent(new Event('input', { bubbles: true }))
  }
}
