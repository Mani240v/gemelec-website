# Vercel Form Setup

The website contact form submits to `/api/lead`.

## Production architecture (2026-07-07)

Leads are captured via the **n8n webhook**. The workflow appends rows to the Google Sheet and sends email notifications.

| Step | Component |
|------|-----------|
| 1 | Form POST → `/api/lead` on Vercel |
| 2 | Vercel POSTs lead JSON to n8n webhook |
| 3 | n8n appends row to `Web Leads` tab |
| 4 | n8n emails lead notification |

Direct Vercel → Google Sheets API is coded in `api/lead.js` but **not configured in Production** (no service account env vars). The form still returns 200 if either sheet append or webhook succeeds.

## Required Vercel Environment Variables (Production)

| Name | Value |
| --- | --- |
| `N8N_LEAD_WEBHOOK_URL` | `https://jules02.app.n8n.cloud/webhook/gemelec-lead` |

Set in **Production only** so preview deploys do not fire real lead emails.

## Google Sheet

| Field | Value |
| --- | --- |
| Name | Gemelec Web Leads |
| ID | `1E5So0KBv8geIEahMrw3qaZGzjDll2pDrugjGikwei4c` |
| Tab | `Web Leads` |

n8n workflow `Gemelec Website Lead Notifications` writes to this sheet via OAuth (`Google Sheets account 2`).

## Optional: direct sheet write from Vercel

If you want Vercel to append rows directly (redundant with n8n, but useful as fallback):

| Name | Value |
| --- | --- |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | Service account email with sheet Editor access |
| `GOOGLE_PRIVATE_KEY` | Private key including `-----BEGIN PRIVATE KEY-----` / `-----END PRIVATE KEY-----` |
| `GOOGLE_SHEET_ID` | `1E5So0KBv8geIEahMrw3qaZGzjDll2pDrugjGikwei4c` |
| `GOOGLE_SHEET_TAB` | `Web Leads` |

Share the sheet with the service account email as Editor.

## Local Test

```sh
npm run dev:vercel
```

## Job Request Tool (`/job-request` + `/job-requests` dashboard)

Standalone "snap, send, solve" style intake tool — see `job-request.html`, `job-requests.html`,
and `api/job-request.js` / `api/job-requests-*.js`. Reuses the same Google service account as
the lead form above (`GOOGLE_SERVICE_ACCOUNT_EMAIL` / `GOOGLE_PRIVATE_KEY`), just shared with a
new Sheet and Drive folder.

### One-time manual setup

1. **Google Sheet.** Create a new Sheet (e.g. "Gemelec Job Requests"), add a tab named `Job
   Requests` with a header row matching the `HEADERS` array in `api/job-request.js`. Share it
   with the existing service account email (see `GOOGLE_SERVICE_ACCOUNT_EMAIL`) as **Editor**.
2. **Google Drive folder.** Create a new folder (e.g. "Gemelec Job Request Photos"). Share it
   with the same service account email as **Editor**. Uploaded photos are set to
   "anyone with the link can view" so the dashboard can render thumbnails — they are not fully
   private, just unlisted.
3. **Anthropic API key.** Create one at console.anthropic.com (with billing enabled) for the
   AI-drafted costing step.
4. **Resend account (internal notification email only — never emails the customer).** Sign up
   free at resend.com, verify the `gemelec.sydney` (or `.com.au`) domain by adding the one DNS
   record Resend provides — this doesn't touch existing mail, it just proves domain ownership so
   an automated sender address is trusted. Grab an API key. The notification goes FROM an
   automated address (e.g. `notifications@gemelec.sydney`) TO the real inbox
   `info@gemelec.sydney` — no new mailbox needed.
5. **Dashboard password.** Pick a real, non-guessable password for `/job-requests`.

### Environment variables (Production + Preview)

| Name | Value |
| --- | --- |
| `JOB_REQUESTS_SHEET_ID` | ID of the new Sheet from step 1 |
| `JOB_REQUESTS_SHEET_TAB` | `Job Requests` |
| `DRIVE_FOLDER_ID` | ID of the new Drive folder from step 2 |
| `ANTHROPIC_API_KEY` | Key from step 3 |
| `RESEND_API_KEY` | Key from step 4 |
| `NOTIFY_EMAIL_FROM` | e.g. `notifications@gemelec.sydney` |
| `NOTIFY_EMAIL_TO` | `info@gemelec.sydney` |
| `NOTIFY_EMAIL_CC` | Optional. e.g. `mani@gemelec.sydney` — omit to skip CC |
| `DASHBOARD_PASSWORD` | Password from step 5 |

Set in both Production and Preview (unlike `N8N_LEAD_WEBHOOK_URL` above) so this can be tested on
a Preview deploy before merging to `main`.

### Notes

- If `DRIVE_FOLDER_ID`, `ANTHROPIC_API_KEY`, or the Resend vars are missing, the corresponding
  step is skipped gracefully (no photos / no AI draft / no notification email) — the submission
  still gets recorded in the Sheet either way.
- The AI-drafted costing is a **draft only**, grounded in `api/price-list.json` (a sanitized
  export of the real price list — sell prices only, no buy price/margin). It is never sent to a
  customer automatically; Mani reviews and edits it in the dashboard before quoting.
