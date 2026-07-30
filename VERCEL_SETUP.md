# Vercel Form Setup

Both `contact.html` and `job-request.html` submit to the same endpoint, `/api/job-request`
(see `api/job-request.js`). There is no separate lead-capture pipeline any more — `api/lead.js`
and the n8n webhook it posted to have been retired; everything lands in one Google Sheet, with
one AI-drafted rough costing, one dashboard, and email + WhatsApp alerts.

## One-time manual setup

1. **Google Sheet.** Create a new Sheet (e.g. "Gemelec Job Requests"), add a tab named `Job
   Requests` with a header row matching the `HEADERS` array in `api/job-request.js`. Share it
   with the service account email below as **Editor**.
2. **Google service account.** Create one (or reuse an existing one) with the Sheets API and
   Drive API enabled, and download its key. This is used to write rows and (optionally) upload
   photos — no `googleapis` dependency, `api/_lib/google-auth.js` hand-signs the OAuth JWT.
3. **Google Drive folder.** Create a new folder (e.g. "Gemelec Job Request Photos"). Share it
   with the same service account email as **Editor**. Uploaded photos are set to
   "anyone with the link can view" so the dashboard can render thumbnails — they are not fully
   private, just unlisted.
4. **Anthropic API key.** Create one at console.anthropic.com (with billing enabled) for the
   AI-drafted costing step.
5. **Resend account (internal notification email only — never emails the customer).** Sign up
   free at resend.com, verify the `gemelec.sydney` (or `.com.au`) domain by adding the one DNS
   record Resend provides — this doesn't touch existing mail, it just proves domain ownership so
   an automated sender address is trusted. Grab an API key. The notification goes FROM an
   automated address (e.g. `notifications@gemelec.sydney`) TO the real inbox
   `info@gemelec.sydney` — no new mailbox needed.
6. **Dashboard password.** Pick a real, non-guessable password for `/job-requests`.
7. **Google Maps API key (address autocomplete).** In Google Cloud Console, create a project (or
   reuse one), enable **Maps JavaScript API** and **Places API**, enable billing (Google Maps
   Platform has a recurring free monthly credit that comfortably covers a small lead-gen form),
   then create an API key. Restrict it by **HTTP referrer** to `https://www.gemelec.com.au/*` and
   `https://gemelec.com.au/*` (add your Preview/`*.vercel.app` domain too if testing there). This
   key is **not** a Vercel env var — the site has no build step, so it's a plain string in both
   `job-request.html` and `contact.html`. Replace the placeholder `GOOGLE_MAPS_API_KEY` in each
   page's Maps script tag with the real key. It's meant to be public (that's what the referrer
   restriction is for), same as any client-side Maps JS key.
8. **WhatsApp alerts (optional, via Twilio).** Sign up at twilio.com, grab the Account SID and
   Auth Token from the console. For testing, join the Twilio WhatsApp **Sandbox** (send the join
   code from Mani's WhatsApp to the sandbox number) — this gives you a working sender in minutes,
   but only delivers to numbers that have joined the sandbox. For production, apply for a WhatsApp
   Business sender in the Twilio console (Meta business verification, can take a few days) and get
   it approved. **Important limitation**: Twilio/WhatsApp only allows freeform message bodies
   (like the alert text this app sends) within 24 hours of the recipient last messaging the
   sender. Outside that window, only a pre-approved message *template* can be sent — if alerts
   stop arriving after a day of no reply from Mani's WhatsApp, that's why. If this turns out to be
   a real problem in practice, the fix is a Twilio Content Template (approved once, then reusable)
   rather than the plain-text body currently sent.

## Environment variables (Production + Preview)

| Name | Value |
| --- | --- |
| `JOB_REQUESTS_SHEET_ID` | ID of the Sheet from step 1 |
| `JOB_REQUESTS_SHEET_TAB` | `Job Requests` |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | Service account email from step 2 |
| `GOOGLE_PRIVATE_KEY` | Private key including `-----BEGIN PRIVATE KEY-----` / `-----END PRIVATE KEY-----` |
| `DRIVE_FOLDER_ID` | ID of the Drive folder from step 3 |
| `ANTHROPIC_API_KEY` | Key from step 4 |
| `RESEND_API_KEY` | Key from step 5 |
| `NOTIFY_EMAIL_FROM` | e.g. `notifications@gemelec.sydney` |
| `NOTIFY_EMAIL_TO` | `info@gemelec.sydney` |
| `NOTIFY_EMAIL_CC` | Optional. e.g. `mani@gemelec.sydney` — omit to skip CC |
| `DASHBOARD_PASSWORD` | Password from step 6 |
| `TWILIO_ACCOUNT_SID` | From step 8 — omit to skip WhatsApp alerts entirely |
| `TWILIO_AUTH_TOKEN` | From step 8 |
| `TWILIO_WHATSAPP_FROM` | Twilio's sandbox number (or your approved sender), e.g. `+14155238886` |
| `NOTIFY_WHATSAPP_TO` | Mani's WhatsApp number, e.g. `+61498351351` |

Set in both Production and Preview so this can be tested on a Preview deploy before merging to
`main`.

## Local Test

```sh
npm run dev:vercel
```

## Notes

- If `DRIVE_FOLDER_ID`, `ANTHROPIC_API_KEY`, the Resend vars, or the Twilio vars are missing, the
  corresponding step is skipped gracefully (no photos / no AI draft / no email / no WhatsApp) —
  the submission still gets recorded in the Sheet either way. Email and WhatsApp are independent;
  either, both, or neither can be configured.
- The AI-drafted costing is a **draft only**, grounded in `api/price-list.json` (a sanitized
  export of the real price list — sell prices only, no buy price/margin). It is never sent to a
  customer automatically; Mani reviews and edits it in the dashboard before quoting.
- Photos are optional on both forms — a submission with none still gets an AI summary/costing
  attempt from the description text alone.
