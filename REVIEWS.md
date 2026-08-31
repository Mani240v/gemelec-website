# Adding Google reviews to the site

Everything to do with reviews lives in **`index.html`** — the carousel is the only
place review cards appear anywhere on the site. The review *count*, however, is
duplicated across all 25 pages, so a count change is always a find-and-replace.

## Current state

- 9 review cards, newest first, in `.gx-reviews-swiper`
- Google rating **4.9 from 88 reviews** (as at 2026-08-31)

## Adding a review

1. **Add the card** to the top of `.swiper-wrapper` in `index.html`. Copy an
   existing `.swiper-slide` block — the Google "G" SVG is inlined in each card,
   so duplicate a whole slide rather than hand-writing one.

2. **Set the date, not the age.** The timestamp element is:

   ```html
   <time class="gx-rcard-when" datetime="2026-08-10">Aug 2026</time>
   ```

   `datetime` is the real review date. The `Mon YYYY` text is only the no-JS
   fallback. A script in `index.html` rewrites it to "3 weeks ago" on every page
   load, so ages never go stale and must never be hardcoded.

3. **Update the count** if it changed. It appears in four different shapes —
   grep for the old number and check each hit:
   - `"reviewCount": "NN"` — JSON-LD, all 25 pages
   - `<small>(NN)</small>` and `Google Rating (NN)` — homepage badge and stat
   - `NN Google reviews` / `NN verified Google reviews` / `across NN reviews` —
     visible prose, 13 suburb pages, worded differently on each

   Beware of `587 Bunnerong Rd`, the `#2d8587` hover colour and
   `Gemelec-Home_87cd9a88.webp` — never blanket-replace a bare number.

4. **Verify by rendering**, not by reading the diff. The Swiper CDN can be
   blocked, so check the timestamps still resolve:

   ```bash
   python3 -m http.server 3456 &
   /opt/pw-browsers/chromium_headless_shell-*/chrome-linux/headless_shell \
     --no-sandbox --virtual-time-budget=4000 --dump-dom http://127.0.0.1:3456/index.html
   ```

   Review ages must read "3 weeks ago", not "Aug 2026". If they show the
   fallback, the timestamp script did not run.

## Where new reviews come from

Google emails `businessprofile-noreply@google.com` on every new review. As of
2026-08-31 these reach `mani@gemelec.sydney` — before that date the Business
Profile was owned by a different Google account, so no review mail existed in
this mailbox. Alerts are not retroactive: reviews posted before 2026-08-31 have
no email, and that absence is expected, not a fault.

That sender also carries profile admin mail (ownership invitations, performance
summaries, verification notices). Filter to actual review notifications.

The email's received date is the review date, and it is exact — better than the
approximate dates reconstructed for the nine cards already on the site.

A "Weekly Gemelec review check" Routine runs Mondays 8am Sydney against this
mailbox and stages new reviews on a `claude/reviews-<date>` branch for approval.
A new-review email does not establish a new review *total* — reviews get removed
too — so the count only changes on a trustworthy figure from the profile itself.

## Rules

- **Never invent a review, a name, or a date.** Only publish what came from the
  Google Business Profile.
- **Do not source reviews from web search.** Search results serve stale cached
  copies of this very site — including fabricated testimonials deleted in
  July 2026 (`79c90ee`), which will otherwise get reintroduced. Confirmed
  2026-08-31.
- The review count in search results is likewise this site's own old number
  read back. It is not a live signal and cannot be used to detect new reviews.
- G A Tigani's review keeps the original "Manny" spelling. It is verbatim from
  Google and is the one intended exception to Manny→Mani.
- Quote reviews as written. Fix nothing, tidy nothing.
- Only 4- and 5-star reviews belong in the carousel. A lower-rated one is a
  reply-to-the-customer job, not a website job — raise it, don't publish it.
