// Service worker for the field portal.
//
// Scope is deliberately narrow: this caches the /tech shell so the portal opens instantly
// and still renders with a weak signal. It does NOT cache the marketing site, and it never
// caches an API response — a stale job list or a replayed submission is worse than an error.
//
// It also does not yet queue submissions made with no signal. That needs IndexedDB plus
// Background Sync and careful thought about duplicates; until then js/tech-portal.js keeps
// the typed text in localStorage and tells the tech to hit send again once they have a bar.
// The honest failure is better than a queue that silently loses or double-sends a job.
const CACHE = 'gemelec-tech-v1'
const SHELL = ['/tech', '/css/style.css', '/js/tech-portal.js', '/images/apple-touch-icon.png']

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting())
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  )
})

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return

  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return
  if (url.pathname.startsWith('/api/')) return

  // Network first, cache as the fallback. The opposite would pin a tech to whatever build
  // their phone first downloaded — the exact trap the site-wide immutable cache header set
  // on 2026-09-01, and not one to rebuild here.
  event.respondWith(
    fetch(request)
      .then(response => {
        if (response && response.status === 200 && response.type === 'basic') {
          const copy = response.clone()
          caches.open(CACHE).then(cache => cache.put(request, copy)).catch(() => {})
        }
        return response
      })
      .catch(() => caches.match(request).then(hit => hit || caches.match('/tech')))
  )
})
