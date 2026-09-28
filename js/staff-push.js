// New-enquiry notifications for this device: turn on, send a test, turn off. Loaded by both
// staff pages (/tech and /job-requests) and drawn into their #staff-push box, which sits
// inside the signed-in part of each page. The server side is api/push-subscribe.js and
// api/_lib/web-push.js; the notification itself is shown by the push handler in sw.js.
//
// iPhone only allows web push from a web app added to the home screen (iOS 16.4+), and only
// from a tap. In an iPhone browser tab this explains how to get there instead of offering a
// button that can't work.
;(function () {
  const box = document.getElementById('staff-push')
  if (!box) return

  const KEY_STORE = 'gemelec_push_key' // the server key this device subscribed with
  const SYNC_STORE = 'gemelec_push_synced' // last day this device re-registered itself
  const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
  const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  const installed = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true

  function store(key, value) {
    try {
      if (value === null) localStorage.removeItem(key)
      else localStorage.setItem(key, value)
    } catch {}
  }
  function stored(key) {
    try { return localStorage.getItem(key) } catch { return null }
  }

  // Everything in the box is built from DOM nodes; server messages go in as text only.
  function draw(lead, buttons, note) {
    box.textContent = ''
    const p = document.createElement('p')
    p.className = 'staff-push-lead'
    p.textContent = lead
    box.appendChild(p)
    if (buttons.length) {
      const row = document.createElement('div')
      row.className = 'staff-push-actions'
      buttons.forEach(([label, action, primary]) => {
        const b = document.createElement('button')
        b.type = 'button'
        b.className = primary ? 'btn btn-primary' : 'staff-push-link'
        b.textContent = label
        b.addEventListener('click', action)
        row.appendChild(b)
      })
      box.appendChild(row)
    }
    if (note) {
      const n = document.createElement('p')
      n.className = 'staff-push-note'
      n.setAttribute('role', 'status')
      n.textContent = note
      box.appendChild(n)
    }
    box.hidden = false
  }

  function busy(label) {
    box.querySelectorAll('button').forEach(b => { b.disabled = true })
    const note = box.querySelector('.staff-push-note') || box.appendChild(document.createElement('p'))
    note.className = 'staff-push-note'
    note.textContent = label
  }

  function keyBytes(base64url) {
    const padded = (base64url + '='.repeat((4 - (base64url.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/')
    const raw = atob(padded)
    return Uint8Array.from(raw, c => c.charCodeAt(0))
  }

  async function api(method, body) {
    const response = await fetch('/api/push-subscribe', {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined
    })
    const result = await response.json().catch(() => ({}))
    return { response, result }
  }

  async function registration() {
    await navigator.serviceWorker.register('/sw.js')
    return navigator.serviceWorker.ready
  }

  // A fresh subscription under the server's current key, saved on the server.
  async function subscribe(publicKey) {
    const reg = await registration()
    const old = await reg.pushManager.getSubscription()
    if (old) await old.unsubscribe().catch(() => {})
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) })
    const saved = await api('POST', { subscription: sub.toJSON() })
    if (!saved.response.ok) throw new Error(saved.result.message || 'Could not save this device.')
    store(KEY_STORE, publicKey)
    store(SYNC_STORE, new Date().toDateString())
    return sub
  }

  function showOff(note) {
    draw('Get a notification on this device the moment a website enquiry comes in.',
      [['Turn on notifications', turnOn, true]], note)
  }

  function showOn(note) {
    draw('Notifications are on for this device. Every website enquiry pops up here.',
      [['Send a test', sendTest, false], ['Turn off', turnOff, false]], note)
  }

  async function turnOn() {
    // Asked first, straight from the tap: iPhone ignores a permission request that follows
    // an await.
    const permission = await Notification.requestPermission()
    if (permission !== 'granted') {
      return showOff(permission === 'denied'
        ? 'Notifications are blocked for this site. Allow them in your phone or browser settings, then reload.'
        : 'Not turned on. Tap the button again and choose Allow.')
    }
    busy('Turning on...')
    try {
      const { response, result } = await api('GET')
      if (!response.ok) throw new Error(result.message || 'Sign in with the office password first.')
      await subscribe(result.publicKey)
      showOn('Done. Tap "Send a test" to check one arrives.')
    } catch (error) {
      showOff(error.message || 'That did not work. Try again in a moment.')
    }
  }

  async function sendTest() {
    busy('Sending a test...')
    try {
      const reg = await registration()
      const sub = await reg.pushManager.getSubscription()
      if (!sub) return showOff('This device is not signed up any more. Turn notifications on again.')
      const { response, result } = await api('POST', { subscription: sub.toJSON(), test: true })
      if (!response.ok) throw new Error(result.message || 'The test did not go through.')
      showOn('Test sent. It should pop up in a few seconds.')
    } catch (error) {
      showOn(error.message || 'The test did not go through.')
    }
  }

  async function turnOff() {
    busy('Turning off...')
    try {
      const reg = await registration()
      const sub = await reg.pushManager.getSubscription()
      if (sub) {
        await api('DELETE', { endpoint: sub.endpoint }).catch(() => {})
        await sub.unsubscribe().catch(() => {})
      }
      store(KEY_STORE, null)
      store(SYNC_STORE, null)
      showOff('Notifications are off for this device.')
    } catch {
      showOn('Could not turn off right now. Try again in a moment.')
    }
  }

  // On opening: keep a subscribed device registered, and resubscribe it if the server's key
  // has changed (the signing secret was rotated), since the old subscription stops working.
  async function init() {
    if (!supported) {
      if (isIOS && !installed) {
        draw('Want a notification for every website enquiry? On iPhone, add this page to your home screen first (Share, then Add to Home Screen), open it from there, and turn notifications on.', [])
      }
      return
    }
    if (Notification.permission === 'denied') {
      return draw('Notifications are blocked for this site. Allow them in your phone or browser settings to get an alert for every website enquiry.', [])
    }
    let sub = null
    try {
      sub = await (await registration()).pushManager.getSubscription()
    } catch {}
    if (!sub || Notification.permission !== 'granted') return showOff()
    showOn()
    try {
      const { response, result } = await api('GET')
      if (!response.ok) return // not signed in yet on this device; the box stays as it is
      if (stored(KEY_STORE) !== result.publicKey) {
        await subscribe(result.publicKey)
      } else if (stored(SYNC_STORE) !== new Date().toDateString()) {
        const saved = await api('POST', { subscription: sub.toJSON() })
        if (saved.response.ok) store(SYNC_STORE, new Date().toDateString())
      }
    } catch {}
  }

  init()
})()
