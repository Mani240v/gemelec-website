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
  const DISMISS_STORE = 'gemelec_push_dismissed' // "Not now" tapped: keep the prompt to one line
  let noteTimer = null
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
  //
  // compact: one small line (the "on" state, and "off" after Not now) instead of a card.
  // Mani, 2026-09-29: the full card took up the whole top of the screen every time the page
  // opened, long after it had done its job.
  function draw(lead, buttons, note, compact) {
    clearTimeout(noteTimer)
    box.textContent = ''
    box.classList.toggle('is-compact', Boolean(compact))
    const line = document.createElement(compact ? 'div' : 'p')
    line.className = compact ? 'staff-push-line' : 'staff-push-lead'
    if (lead) {
      const text = document.createElement('span')
      text.textContent = lead
      line.appendChild(text)
    }
    const row = compact ? line : document.createElement('div')
    if (!compact) row.className = 'staff-push-actions'
    buttons.forEach(([label, action, primary]) => {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = primary && !compact ? 'btn btn-primary' : 'staff-push-link'
      b.textContent = label
      b.addEventListener('click', action)
      row.appendChild(b)
    })
    box.appendChild(line)
    if (!compact && buttons.length) box.appendChild(row)
    if (note) {
      const n = document.createElement('p')
      n.className = 'staff-push-note'
      n.setAttribute('role', 'status')
      n.textContent = note
      box.appendChild(n)
    }
    box.hidden = false
  }

  // A confirmation ("Test sent...") only needs to be read once: let it go after a while so
  // the box shrinks back to its one line.
  function fadeNote(ms) {
    clearTimeout(noteTimer)
    noteTimer = setTimeout(() => {
      const n = box.querySelector('.staff-push-note')
      if (n) n.remove()
    }, ms)
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
    if (stored(DISMISS_STORE) === '1' && !note) {
      return draw('', [['Turn on notifications for new enquiries', turnOn, false]], null, true)
    }
    draw('Get a notification on this device the moment a website enquiry comes in.',
      [['Turn on notifications', turnOn, true], ['Not now', notNow, false]], note)
  }

  function notNow() {
    store(DISMISS_STORE, '1')
    showOff()
  }

  function showOn(note) {
    draw('Notifications on for this device.',
      [['Send a test', sendTest, false], ['Turn off', turnOff, false]], note, true)
    // Long ones are instructions; leave time to follow them.
    if (note) fadeNote(note.length > 120 ? 90000 : 15000)
  }

  // Information the owner can't act on from here (iPhone tab, unsupported browser, blocked):
  // shown once, with a way to put it away for good on this device.
  function showInfo(text) {
    if (stored(DISMISS_STORE) === '1') return
    draw(text, [['Hide', () => { store(DISMISS_STORE, '1'); box.hidden = true }, false]], null, false)
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
      store(DISMISS_STORE, null)
      showOn('Done. Tap "Send a test" to check one arrives.')
    } catch (error) {
      showOff(plain(error, 'This browser could not turn notifications on. Try again in a moment, or use Chrome or Safari.'))
    }
  }

  // retried: the push service said this device's sign-up was gone (410), so it was signed up
  // afresh and this is the one retry. A second "gone" means the browser itself isn't taking
  // pushes, and no amount of re-subscribing will fix that.
  async function sendTest(retried) {
    busy(retried === true ? 'Signing this device up again and resending...' : 'Sending a test...')
    try {
      const reg = await registration()
      const sub = await reg.pushManager.getSubscription()
      if (!sub) return showOff('This device is not signed up any more. Turn notifications on again.')
      // Listen before sending: on a good connection the push can land before the reply does.
      const arrival = waitForArrival(12000)
      const { response, result } = await api('POST', { subscription: sub.toJSON(), test: true })
      if (response.status === 410 && result.gone) {
        if (retried === true) {
          return showOff("This browser keeps dropping its notification sign-up, so it can't receive them. In the browser's settings, check notifications are allowed for gemelec.com.au, then turn them on here again. On Windows also check Settings, System, Notifications is on for the browser. If it still won't, use your phone.")
        }
        const key = await api('GET')
        if (!key.response.ok) throw ours(key.result.message || 'Sign in with the office password first.')
        await subscribe(key.result.publicKey)
        return sendTest(true)
      }
      if (!response.ok) throw ours(result.message || 'The test did not go through.')
      busy('Test sent. Checking it reaches this device...')
      // The server also checked this device is on the list real enquiries go to (the test
      // itself never reads that list), and put it back if not.
      const relisted = result.relisted
        ? 'This device had dropped off the list for real enquiries, so any before now missed it. It\'s back on. '
        : ''
      // The two ways a sent test goes missing need different fixes, so say which it was.
      if (await arrival) {
        showOn(relisted + 'The test reached this device. If it didn\'t pop up, this device is hiding notifications: on Windows check Settings, System, Notifications (notifications on, Google Chrome on, Do not disturb off); on a Mac check System Settings, Notifications and that Focus is off.')
      } else {
        showOn(relisted + "The test was sent but didn't reach this device. On a computer that's usually a firewall, antivirus or VPN blocking Chrome's notification connection, or Chrome running in a mode that can't get them (a guest or incognito window). Your phone will still get them through the GEMELEC app. (Just refreshed this page? Give it ten seconds and try the test once more first.)")
      }
    } catch (error) {
      showOn(plain(error, 'The test did not go through. Try again in a moment.'))
    }
  }

  // Resolves true when sw.js reports the test push arrived on this device, false after ms.
  function waitForArrival(ms) {
    return new Promise(resolve => {
      const onMessage = (e) => {
        if (e.data && e.data.type === 'gemelec-push-received' && e.data.tag === 'gemelec-test') done(true)
      }
      const timer = setTimeout(() => done(false), ms)
      function done(arrived) {
        clearTimeout(timer)
        navigator.serviceWorker.removeEventListener('message', onMessage)
        resolve(arrived)
      }
      navigator.serviceWorker.addEventListener('message', onMessage)
      // Messages from the worker queue until this is called (or the page finishes loading).
      if (navigator.serviceWorker.startMessages) navigator.serviceWorker.startMessages()
    })
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
  // Capped at four seconds: on a stalled connection sign-out mustn't sit there doing nothing.
  window.gxPushSignOut = () => Promise.race([unsubscribeHere(), new Promise(resolve => setTimeout(resolve, 4000))])

  // On opening: only for an office sign-in, and keep a subscribed device registered. The
  // re-save on every open matters: after the password changes the server drops old records,
  // and this is how a device that's signed in again gets back on the list.
  async function init() {
    // Start hidden every time: this also runs after a sign-in, and a box drawn for the last
    // person (say, an office user whose session lapsed before a tech unlocked) mustn't linger.
    box.hidden = true
    box.textContent = ''
    if (!supported) {
      // Say why rather than show nothing: an owner who was told to look for this box and
      // can't find it has no way to know the browser is the reason.
      const { response } = await api('GET').catch(() => ({ response: { ok: false } }))
      if (!response.ok) return
      if (isIOS && !installed) {
        showInfo(onPortal
          ? 'Want a notification for every website enquiry? On iPhone, add this page to your home screen first (Share, then Add to Home Screen), open GEMELEC from your home screen, and turn notifications on there.'
          : 'Want a notification for every website enquiry? On iPhone this works from the GEMELEC app: open gemelec.com.au/tech in Safari, tap Share, then Add to Home Screen, open GEMELEC from your home screen, sign in, and turn notifications on there.')
      } else {
        showInfo('This browser can\'t show notifications for new website enquiries. Open this page in Chrome, or in Safari on an up-to-date Mac or iPhone, and turn them on there.')
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
      return showInfo('Notifications are blocked for this site. Allow them in your phone or browser settings to get an alert for every website enquiry.')
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
