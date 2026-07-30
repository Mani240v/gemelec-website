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
