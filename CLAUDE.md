# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Static marketing website for Gemelec Electrical Services (Sydney electrician). Plain HTML/CSS/JS with Vercel serverless functions for lead/job capture. No framework, no build step, no bundler, no npm dependencies (the API functions use Node built-ins only; the frontend pulls Swiper from a CDN). Git remote is `github.com/Mani240v/gemelec-website`, deployed on Vercel.

## How to work with Mani

- Talking to Mani: he likes seeing the nuts and bolts, so keep the technical detail,
  the evidence and the reasoning. Then finish anything non-trivial with a short
  plain-English wrap-up, pitched at a 40-year-old with general IT knowledge: what
  changed, what it means for him, and what he needs to do next (often nothing). No
  jargon in that part, and no file paths, commands or code unless he has to type
  them himself.

## Commands

```bash
npm run dev         # npx serve . -p 3456 — static preview, does NOT run /api/job-request
npm run dev:vercel  # vercel dev on 3456 — required to exercise the job-request form endpoint
```

There is no build, lint, or test step. "Editing" is editing HTML/CSS/JS directly; "verifying" is loading the page. Use `npm run dev:vercel` whenever a change touches `api/job-request.js`, either form, or anything that posts to `/api/job-request`.

## Architecture

### No templating — page chrome is duplicated into every file
There are ~38 standalone HTML files and **no shared header/nav/footer partial**. The `<head>`, top nav, and footer are hand-copied into each page. A change to any shared element (nav links, footer, phone number, logo, a new `<head>` tag) must be applied to **every** HTML file, not one. Active nav state is hard-coded per page via `class="active"`, not computed by JS. Treat any "site-wide" copy or markup change as a multi-file find-and-replace.

### Page taxonomy
- Root pages: `index`, `services`, `about`, `contact`, `blog`, `privacy-policy`.
- `electrician/<suburb>.html` — 24 suburb landing pages (Matraville, Bondi, Coogee, etc.). These share component blocks: breadcrumb, suburb hero, area grid, FAQ, related services, nearby suburbs.
- `services/<slug>.html` — 6 service detail pages (emergency, switchboard upgrades, EV charger, lighting, commercial, security). Share: service detail hero, included grid, process steps, FAQ, related services.

Adding a page means also updating `sitemap.xml`, the nav block in every page (if it belongs in nav), and `llms.txt`.

### Job request pipeline (single pipeline for both `/contact` and `/job-request`)
Both `contact.html` (`form#job-request-form`) and `job-request.html` (same form id) share `js/job-request.js` for photo compression, address autocomplete, and submit handling → `POST /api/job-request` → `api/job-request.js` appends a row to Google Sheets, best-effort uploads photos to Drive, best-effort drafts an AI rough costing (`api/_lib/anthropic.js`), and fires best-effort email (Resend) + WhatsApp (Twilio) alerts. There is no separate lead-capture pipeline — `api/lead.js` and the n8n webhook it used were retired in favor of this one.

- `api/job-request.js` is a Vercel serverless function. It mints a Google OAuth token by hand-signing a JWT (RS256 via `node:crypto`) — there is no `googleapis` dependency. Sheet target comes from env vars (see `VERCEL_SETUP.md`).
- Honeypot field: `company_website`. If filled, the function returns `200 ok` without writing (silent bot drop).
- Required fields: `full_name` (sent as `first_name`/`last_name` from the form, combined client-side), `phone`, `description`. Photos are optional (up to 5) — a submission with none still gets an AI summary attempt from the description text alone.
- The `HEADERS` array in `api/job-request.js` defines the exact sheet column order. **To add a form field you must touch three places**: the form HTML (both `contact.html` and `job-request.html` if it applies to both), the payload object in `js/job-request.js`, and both `HEADERS` + the `row` object in `api/job-request.js`.
- Dashboard at `/job-requests` (password-gated, see `DASHBOARD_PASSWORD`) is where every submission — general enquiry or job-with-photos — gets reviewed, AI costing edited, and status tracked.

### CSS
Single file `css/style.css` (~2350 lines), organized by `/* ─── Section ─── */` comment banners. New component groups are appended at the bottom under a dated comment (e.g. `/* === ADDED 2026-05-14 ... === */`) rather than edited inline. Follow that convention. Client brand fonts are **Barlow Condensed + DM Sans** (this is Gemelec's brand, not switchflow's — do not apply switchflow brand fonts/colours here).

### Deployment config
`vercel.json` sets `cleanUrls: true` (URLs are extensionless: `/about`, `/services/emergency-electrician`), plus security headers and 1-year immutable cache on `/images`, `/css`, `/js`.

## Conventions and gotchas

- **Internal links are mixed style.** Root pages link with absolute extensionless paths (`/about`, `/services`). Suburb pages link to parents/siblings with relative `.html` (`../about.html`, `coogee.html`) and to services with absolute extensionless (`/services/emergency-electrician`). `cleanUrls` makes all of these resolve. Match the style already used in the file you are editing rather than normalizing.
- **Canonical domain is `https://www.gemelec.com.au`.** Every page's `canonical`, `og:url`, JSON-LD `url`, plus `sitemap.xml`, `robots.txt`, and `llms.txt` were migrated off the old `gemelec-website.netlify.app` domain. Keep new pages consistent with this.
- **Analytics is a placeholder.** gtag uses `G-XXXXXXXXXX` in every page — not a real Measurement ID.
- **Copy accuracy matters.** The owner is "Mani" (Emmanuel Gemelas), not "Manny" — a prior pass replaced Manny→Mani site-wide. The one intentional exception is the verbatim G A Tigani Google review, which keeps the original "Manny" spelling. Phone `0498 351 351` and the NSW licence numbers in `llms.txt`/schema are real and load-bearing; do not invent or alter them.
- **JSON-LD schema** (`ElectricalContractor`) is embedded per page in `<head>`. Keep NAP (name/address/phone), licences, and service lists in sync with `llms.txt` and `about.html` when any of them change.
