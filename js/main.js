// Mobile nav toggle
const hamburger = document.querySelector('.hamburger')
const mobileMenu = document.querySelector('.mobile-menu')

if (hamburger && mobileMenu) {
  hamburger.addEventListener('click', () => {
    hamburger.classList.toggle('open')
    mobileMenu.classList.toggle('open')
    hamburger.setAttribute('aria-expanded', hamburger.classList.contains('open') ? 'true' : 'false')
  })
}

// Active nav state is handled by hard-coded class="active" in each page's HTML.
// Contact form is now the shared job-request form/handler (js/job-request.js),
// loaded directly by contact.html.

// Smooth anchor scroll
document.querySelectorAll('a[href^="#"]').forEach(anchor => {
  anchor.addEventListener('click', (e) => {
    const target = document.querySelector(anchor.getAttribute('href'))
    if (target) {
      e.preventDefault()
      target.scrollIntoView({ behavior: 'smooth', block: 'start' })
      if (mobileMenu) mobileMenu.classList.remove('open')
      if (hamburger) hamburger.classList.remove('open')
    }
  })
})

// === ADDED 2026-09-07: GA4 lead tracking ===
//
// GA4 on its own only reports page views, which for this business undercounts
// leads badly. Most people ring rather than fill in the form: there are 187
// tel: links and 40 wa.me links across the public pages against one form. Left
// as-is the reports would make the form look like the only source of work.
//
// All three fire the same `generate_lead` event, separated by a `method`
// parameter, so only ONE key event has to be configured in the GA4 interface
// and the split is still readable as a breakdown by method.
//
// Delegated from document rather than bound per-link: it covers all 227 links
// without touching any HTML, and keeps working if a link is added later.
function trackLead (method, detail) {
  // gtag is defined synchronously by the inline stub in each page's <head>, so
  // it is callable before gtag.js finishes loading — calls queue on dataLayer.
  // Absent entirely on the staff pages (they carry no tag) and when a blocker
  // removes it, hence the guard.
  if (typeof gtag !== 'function') return
  gtag('event', 'generate_lead', { method: method, link_url: detail || '' })
}

document.addEventListener('click', (e) => {
  const link = e.target.closest && e.target.closest('a[href]')
  if (!link) return
  const href = link.getAttribute('href') || ''
  // Never preventDefault or await here — the click must navigate exactly as it
  // did before. GA4 sends via navigator.sendBeacon, which survives the unload.
  if (href.indexOf('tel:') === 0) trackLead('phone', href)
  else if (href.indexOf('wa.me') !== -1) trackLead('whatsapp', href)
})

// A completed job request lands on /thank-you, so arriving there is the lead.
//
// The event is gated on a one-shot token that js/job-request.js writes just
// before it redirects, and this consumes. A sticky "already counted" flag was
// the obvious approach and is wrong: it never clears, so a customer sending a
// second enquiry in the same session — two properties, or a job they forgot to
// mention — would go uncounted. A token that is spent on read gets every case:
//
//   submit -> redirect      token present  -> counted, token cleared
//   refresh / back button   token gone     -> not counted again
//   second submit           token rewritten-> counted
//   bookmark or direct hit  never set      -> not counted
//
// If sessionStorage throws (private mode, storage blocked) the token can never
// have been written, so fall back to firing: over-counting the odd direct visit
// to a noindex page beats silently losing real leads.
if (/^\/thank-you(\.html)?\/?$/.test(window.location.pathname)) {
  let shouldCount
  try {
    shouldCount = sessionStorage.getItem('gx_pending_lead') === '1'
    if (shouldCount) sessionStorage.removeItem('gx_pending_lead')
  } catch (err) {
    shouldCount = true
  }
  if (shouldCount) trackLead('form', window.location.pathname)
}
