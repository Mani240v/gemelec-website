// New-enquiry notifications for this device: turn on, send a test, turn off. Loaded by both
// staff pages (/tech and /job-requests) and drawn into their #staff-push box, which sits
// inside the signed-in part of each page. The server side is api/push-subscribe.js and
// api/_lib/web-push.js; the notification itself is shown by the push handler in sw.js.
//
// The box only appears for an office sign-in (the server refuses anyone else), so a tech on
// a separate code is never asked for a permission they couldn't use.
//
// iPhone only allows web push from a web app on the home screen (iOS 16.4+), and only from a
// tap. The installable app is the Field Portal (/tech has the manifest), so in an iPhone
// browser tab this explains how to get there instead of offering a button that can't work.
;(function () {
  const box = document.getElementById('staff-push')
  if (!box) return

  const KEY_STORE = 'gemelec_push_key' // the server key this device subscribed with
  const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
  const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  const installed = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true
  const onPortal = /^\/tech\/?$/.test(window.location.pathname)

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

  // Our own messages are written for people; a browser's ("Registration failed - push
  // service error") isn't, so those get a plain one.
  function plain(error, fallback) {
    if (error && error.fromUs) return error.message
    return fallback
  }
  function ours(message) {
    const error = new Error(message)
    error.fromUs = true
    return error
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

  // `ready` never settles if the worker failed to install, which would leave the box stuck
  // on "Turning on..."; give it ten seconds.
  async function registration() {
    await navigator.serviceWorker.register('/sw.js')
    return Promise.race([
      navigator.serviceWorker.ready,
      new Promise((resolve, reject) => setTimeout(() => reject(ours('Could not set up this device. Reload the page and try again.')), 10000))
    ])
  }

  // A fresh subscription under the server's current key, saved on the server.
  async function subscribe(publicKey) {
    const reg = await registration()
    const old = await reg.pushManager.getSubscription()
    if (old) {
      await api('DELETE', { endpoint: old.endpoint }).catch(() => {})
      await old.unsubscribe().catch(() => {})
    }
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) })
    const saved = await api('POST', { subscription: sub.toJSON() })
    if (!saved.response.ok) throw ours(saved.result.message || 'Could not save this device.')
    store(KEY_STORE, publicKey)
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
      if (!response.ok) throw ours(result.message || 'Sign in with the office password first.')
      await subscribe(result.publicKey)
      showOn('Done. Tap "Send a test" to check one arrives.')
    } catch (error) {
      showOff(plain(error, 'This browser could not turn notifications on. Try again in a moment, or use Chrome or Safari.'))
    }
  }

  async function sendTest() {
    busy('Sending a test...')
    try {
      const reg = await registration()
      const sub = await reg.pushManager.getSubscription()
      if (!sub) return showOff('This device is not signed up any more. Turn notifications on again.')
      const { response, result } = await api('POST', { subscription: sub.toJSON(), test: true })
      if (!response.ok) throw ours(result.message || 'The test did not go through.')
      showOn('Test sent. It should pop up in a few seconds. Nothing? Check this device allows notifications from the browser (on a Mac: System Settings, Notifications) and that Do Not Disturb or Focus is off. On a computer, the browser has to be open.')
    } catch (error) {
      showOn(plain(error, 'The test did not go through. Try again in a moment.'))
    }
  }

  async function turnOff() {
    busy('Turning off...')
    await unsubscribeHere()
    showOff('Notifications are off for this device.')
  }

  // Also used when signing out on either page (window.gxPushSignOut), so a signed-out device
  // stops getting customer details. Never throws; sign-out must carry on regardless.
  async function unsubscribeHere() {
    try {
      if (!supported) return
      const reg = await navigator.serviceWorker.getRegistration('/')
      const sub = reg && await reg.pushManager.getSubscription()
      if (sub) {
        await api('DELETE', { endpoint: sub.endpoint }).catch(() => {})
        await sub.unsubscribe().catch(() => {})
      }
    } catch {}
    store(KEY_STORE, null)
  }
  window.gxPushSignOut = unsubscribeHere

  // On opening: only for an office sign-in, and keep a subscribed device registered. The
  // re-save on every open matters: after the password changes the server drops old records,
  // and this is how a device that's signed in again gets back on the list.
  async function init() {
    if (!supported) {
      if (isIOS && !installed) {
        const { response } = await api('GET').catch(() => ({ response: { ok: false } }))
        if (!response.ok) return
        draw(onPortal
          ? 'Want a notification for every website enquiry? On iPhone, add this page to your home screen first (Share, then Add to Home Screen), open GEMELEC from your home screen, and turn notifications on there.'
          : 'Want a notification for every website enquiry? On iPhone this works from the GEMELEC app: open gemelec.com.au/tech in Safari, tap Share, then Add to Home Screen, open GEMELEC from your home screen, sign in, and turn notifications on there.', [])
      }
      return
    }

    let server
    try {
      server = await api('GET')
    } catch {
      return // no connection: say nothing rather than something wrong
    }
    if (!server.response.ok) return // not an office sign-in on this device

    if (Notification.permission === 'denied') {
      return draw('Notifications are blocked for this site. Allow them in your phone or browser settings to get an alert for every website enquiry.', [])
    }
    let sub = null
    try {
      sub = await (await registration()).pushManager.getSubscription()
    } catch {}
    if (!sub || Notification.permission !== 'granted') return showOff()

    showOn()
    const publicKey = server.result.publicKey
    if (stored(KEY_STORE) !== publicKey) {
      try {
        await subscribe(publicKey)
      } catch {
        return showOff('Notifications stopped working on this device. Tap "Turn on notifications" to fix it.')
      }
    } else {
      api('POST', { subscription: sub.toJSON() }).catch(() => {})
    }
  }

  // Both pages call this after a sign-in, so the box appears without a reload.
  window.gxPushRefresh = init
  init()
})()
