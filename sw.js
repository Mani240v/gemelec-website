// Service worker for the field portal.
//
// Scope is deliberately narrow: this caches the /tech shell so the portal opens instantly
// and still renders with a weak signal. It does NOT cache the marketing site, and it never
// caches an API response — a stale job list or a replayed submission is worse than an error.
//
// The narrowing lives in the fetch handler, not in the registration. tech.html registers
// this at '/' and the manifest's scope is '/', so on a tech's phone the worker sees every
// request to the site. v1 cached all of them and answered any failure with the /tech page,
// which is why the cache name moved to v2: activate below deletes what v1 collected.
//
// It also does not yet queue submissions made with no signal. That needs IndexedDB plus
// Background Sync and careful thought about duplicates; until then js/tech-portal.js keeps
// the typed text in localStorage and tells the tech to hit send again once they have a bar.
// The honest failure is better than a queue that silently loses or double-sends a job.
const CACHE = 'gemelec-tech-v2'
const SHELL = ['/tech', '/job-requests', '/css/style.css', '/js/tech-portal.js', '/js/job-requests-dashboard.js', '/images/apple-touch-icon.png']

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

  // Only the shell is ours. Anything else returns without respondWith, so the browser
  // fetches it exactly as if no worker were installed. pathname leaves out the query
  // string, so the dashboard's js/job-requests-dashboard.js?v=... still counts as shell.
  if (!SHELL.includes(url.pathname)) return

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
      // Offline with nothing cached for this URL: a page load gets the portal, anything
      // else fails as a plain network error. Answering a script or stylesheet request with
      // the /tech HTML only turns one failure into a stranger one.
      // ignoreSearch because SHELL is precached without the ?v= the pages request with.
      .catch(() => caches.match(request, { ignoreSearch: true }).then(hit => {
        if (hit) return hit
        return request.mode === 'navigate' ? caches.match('/tech') : Response.error()
      }))
  )
})
