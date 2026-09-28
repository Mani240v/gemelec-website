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

// In-page anchors scroll smoothly through `scroll-behavior: smooth` in style.css,
// which already backs off under prefers-reduced-motion. There used to be a JS
// handler here as well; it called preventDefault on every href="#..." link, which
// stopped the skip link from moving keyboard focus past the nav, and it threw a
// SyntaxError on the bare href="#" footer links. Don't bring it back.

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

// === ADDED 2026-09-28: WeChat ===
//
// WeChat has no click-to-chat link like wa.me: a customer can only message the business
// account once they've added it as a friend, and the dependable way in is its QR code. So
// anything marked data-wechat opens a small dialog showing it. Customer-facing wording says
// "Gemelec"/"us", never Mani's name (his request). The account's display name is now
// "GEMELEC Electrical", so the image is WeChat's full QR card with the logo. The element's href is the QR image
// itself, which is the whole fallback: no JS, or no <dialog> support, and the tap just
// opens the picture. The dialog also shows his WeChat ID with a copy button, for people
// who'd rather search than scan. That only works because it's a custom ID (set
// 2026-09-28); the system-assigned wxid_... it replaced can't be searched in WeChat.
//
// Counted as generate_lead with method 'wechat', per the one-key-event rule above.
const WECHAT_QR = '/images/wechat-qr.jpg'
const WECHAT_ID = 'GEMELEC'
let wechatDialog = null

function buildWechatDialog () {
  const dialog = document.createElement('dialog')
  dialog.className = 'wechat-dialog'
  dialog.setAttribute('aria-labelledby', 'wechat-dialog-title')
  // Static markup only; nothing here comes from the page or the visitor.
  dialog.innerHTML =
    '<button type="button" class="wechat-close" aria-label="Close">&times;</button>' +
    '<h2 id="wechat-dialog-title">Add us on WeChat</h2>' +
    '<img src="' + WECHAT_QR + '" width="600" height="805" alt="WeChat QR code for GEMELEC Electrical">' +
    '<p>Scan the code in WeChat to add Gemelec, then message us like any other chat.</p>' +
    '<p class="wechat-id">Or search our WeChat ID: <strong>' + WECHAT_ID + '</strong> <button type="button" class="wechat-copy">Copy</button></p>' +
    '<p>On your phone? Press and hold the code to save it, then in WeChat tap <strong>+</strong>, then <strong>Scan</strong>, and choose the photo from your album.</p>'
  dialog.querySelector('.wechat-close').addEventListener('click', () => dialog.close())
  const copy = dialog.querySelector('.wechat-copy')
  if (navigator.clipboard && navigator.clipboard.writeText) {
    copy.addEventListener('click', () => {
      navigator.clipboard.writeText(WECHAT_ID)
        .then(() => { copy.textContent = 'Copied' })
        .catch(() => {})
    })
  } else {
    copy.hidden = true
  }
  // Close on a backdrop click. The backdrop reports the dialog as the target, so check
  // the point is actually outside the box rather than on its padding.
  dialog.addEventListener('click', (e) => {
    const r = dialog.getBoundingClientRect()
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) dialog.close()
  })
  document.body.appendChild(dialog)
  return dialog
}

document.addEventListener('click', (e) => {
  const trigger = e.target.closest && e.target.closest('[data-wechat]')
  if (!trigger) return
  trackLead('wechat', window.location.pathname)
  if (typeof HTMLDialogElement !== 'function') return // let the link open the image
  e.preventDefault()
  if (!wechatDialog) wechatDialog = buildWechatDialog()
  wechatDialog.showModal()
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
