// Job request form: photo compression + submit handler.
// Shared by both contact.html and job-request.html — same form id, same fields.

const MAX_PHOTOS = 5
const MAX_DIMENSION = 1600
const JPEG_QUALITY = 0.7

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
        resolve({ dataUrl, mimeType: 'image/jpeg', base64: dataUrl.split(',')[1] })
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

  let compressedPhotos = []

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
      removeBtn.addEventListener('click', () => {
        compressedPhotos.splice(index, 1)
        renderPreviews()
      })

      thumb.appendChild(img)
      thumb.appendChild(removeBtn)
      photoPreview.appendChild(thumb)
    })
  }

  if (photosInput) {
    photosInput.addEventListener('change', async () => {
      const files = Array.from(photosInput.files || [])
      const truncated = files.length > MAX_PHOTOS
      const selected = files.slice(0, MAX_PHOTOS)

      if (photosHelp) {
        photosHelp.textContent = truncated
          ? `Only the first ${MAX_PHOTOS} photos are used — remove some and reselect if needed.`
          : 'Compressing photos...'
      }

      compressedPhotos = []
      for (const file of selected) {
        try {
          compressedPhotos.push(await compressImage(file))
        } catch (error) {
          console.error('Photo compression failed:', error)
        }
      }

      if (photosHelp && !truncated) photosHelp.textContent = photosHelpDefault
      renderPreviews()
    })
  }

  jobRequestForm.addEventListener('submit', async (e) => {
    e.preventDefault()

    if (successMsg) successMsg.style.display = 'none'
    if (errorMsg) errorMsg.style.display = 'none'

    if (jobRequestForm.reportValidity && !jobRequestForm.reportValidity()) {
      const firstInvalid = jobRequestForm.querySelector(':invalid')
      if (firstInvalid && typeof firstInvalid.focus === 'function') firstInvalid.focus()
      return
    }

    const submitButton = jobRequestForm.querySelector('button[type="submit"]')
    const originalButtonText = submitButton ? submitButton.textContent : ''

    const fullName = `${jobRequestForm.first_name.value} ${jobRequestForm.last_name.value}`.trim()

    const payload = {
      company_website: jobRequestForm.company_website.value,
      full_name: fullName,
      phone: jobRequestForm.phone.value,
      email: jobRequestForm.email.value,
      job_address: jobRequestForm.job_address.value,
      description: jobRequestForm.description.value,
      photos: compressedPhotos.map(photo => ({ mimeType: photo.mimeType, base64: photo.base64 })),
      source: 'website',
      page_url: window.location.href
    }

    if (submitButton) {
      submitButton.disabled = true
      submitButton.textContent = 'Sending...'
    }

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

      jobRequestForm.reset()
      compressedPhotos = []
      renderPreviews()
      jobRequestForm.style.display = 'none'
      if (successMsg) {
        successMsg.style.display = 'block'
        successMsg.scrollIntoView({ behavior: 'smooth', block: 'center' })
      }
    } catch (error) {
      if (errorMsg) {
        errorMsg.textContent = error.message || 'Sorry, that could not be sent. Please call 0498 351 351.'
        errorMsg.style.display = 'block'
        errorMsg.scrollIntoView({ behavior: 'smooth', block: 'center' })
        if (!errorMsg.hasAttribute('tabindex')) errorMsg.setAttribute('tabindex', '-1')
        if (typeof errorMsg.focus === 'function') errorMsg.focus()
      }
    } finally {
      if (submitButton) {
        submitButton.disabled = false
        submitButton.textContent = originalButtonText
      }
    }
  })
}

// Called by the Google Maps JS API script tag once it's loaded (see job-request.html).
// Global on purpose — that's how the Maps API's `callback` URL param invokes it.
function initAddressAutocomplete() {
  const addressInput = document.getElementById('job_address')
  if (!addressInput || !window.google?.maps?.places) return

  const autocomplete = new google.maps.places.Autocomplete(addressInput, {
    componentRestrictions: { country: 'au' },
    fields: ['formatted_address'],
    types: ['address']
  })

  autocomplete.addListener('place_changed', () => {
    const place = autocomplete.getPlace()
    if (place?.formatted_address) addressInput.value = place.formatted_address
  })
}
