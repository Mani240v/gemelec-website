# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Static marketing website for Gemelec Electrical Services (Sydney electrician). Plain HTML/CSS/JS with one Vercel serverless function for lead capture. No framework, no build step, no bundler, no npm dependencies (the API function uses Node built-ins only; the frontend pulls Swiper from a CDN). Git remote is `github.com/Mani240v/gemelec-website`, deployed on Vercel.

## Commands

```bash
npm run dev         # npx serve . -p 3456 — static preview, does NOT run /api/lead
npm run dev:vercel  # vercel dev on 3456 — required to exercise the lead form endpoint
```

There is no build, lint, or test step. "Editing" is editing HTML/CSS/JS directly; "verifying" is loading the page. Use `npm run dev:vercel` whenever a change touches `api/lead.js`, the form, or anything that posts to `/api/lead`.

## Architecture

### No templating — page chrome is duplicated into every file
There are ~38 standalone HTML files and **no shared header/nav/footer partial**. The `<head>`, top nav, and footer are hand-copied into each page. A change to any shared element (nav links, footer, phone number, logo, a new `<head>` tag) must be applied to **every** HTML file, not one. Active nav state is hard-coded per page via `class="active"`, not computed by JS. Treat any "site-wide" copy or markup change as a multi-file find-and-replace.

### Page taxonomy
- Root pages: `index`, `services`, `about`, `contact`, `blog`, `privacy-policy`.
- `electrician/<suburb>.html` — 24 suburb landing pages (Matraville, Bondi, Coogee, etc.). These share component blocks: breadcrumb, suburb hero, area grid, FAQ, related services, nearby suburbs.
- `services/<slug>.html` — 6 service detail pages (emergency, switchboard upgrades, EV charger, lighting, commercial, security). Share: service detail hero, included grid, process steps, FAQ, related services.

Adding a page means also updating `sitemap.xml`, the nav block in every page (if it belongs in nav), and `llms.txt`.

### Lead form pipeline
`form#quote-form` → `js/main.js` serializes fields + UTM params + page context → `POST /api/lead` → `api/lead.js` appends a row to Google Sheets.

- `api/lead.js` is a Vercel serverless function. It mints a Google OAuth token by hand-signing a JWT (RS256 via `node:crypto`) — there is no `googleapis` dependency. Auth + sheet target come from env vars (see `VERCEL_SETUP.md`); it falls back to hard-coded sheet ID/tab constants if unset.
- Honeypot field: `company_website`. If filled, the function returns `200 ok` without writing (silent bot drop).
- Required fields: `full_name`, `phone`, `suburb`, `service_required`.
- The `HEADERS` array in `api/lead.js` defines the exact sheet column order. **To add a form field you must touch three places**: the form HTML, the payload object in `js/main.js`, and both `HEADERS` + the `row` object in `api/lead.js`.

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
