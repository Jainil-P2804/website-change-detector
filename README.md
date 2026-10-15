# Website Change Detector

Monitor public web pages and get alerted to **meaningful** changes, not to timestamps, view counters, ads and rotating banners.

* Headless-browser rendering (Playwright / Chromium), public pages only, no stored site credentials
* Redis + BullMQ scheduler and job queue with timeouts, exponential-backoff retries and per-domain rate limiting
* Fetch once, notify many: 200 users tracking one URL cost **one** fetch
* Text diffs, highlighted screenshot diffs and a side-by-side view for any two versions
* Email, Telegram, Discord and generic webhook alerts, de-duplicated, with cooldowns and an optional daily digest
* Keyword alerts, number tracking with charts, AI one-line summaries, per-page RSS feeds, browser extension API, visual region picker

> **Status:** reference implementation. The pure logic (noise filter, URL normalization, classification, number/keyword parsing, volatility detection) has unit tests. The full stack (Postgres, Redis, Chromium, SMTP) has not been exercised end-to-end, so run it against a staging environment before relying on it.

---

## Contents

1. [Architecture](#architecture)
2. [Repository structure](#repository-structure)
3. [Quick start (Docker Compose)](#quick-start-docker-compose)
4. [Configuration](#configuration)
5. [How the four hard problems are solved](#how-the-four-hard-problems-are-solved)
6. [Feature notes](#feature-notes)
7. [API reference](#api-reference)
8. [Security model](#security-model)
9. [Known limitations and next steps](#known-limitations-and-next-steps)
10. [Development and tests](#development-and-tests)

---

## Architecture

```
                        ┌─────────────────────────┐
  Dashboard (web/) ───► │  API  (Express)         │ ◄─── Browser extension
  Alert links / RSS ──► │  auth, targets, diffs,  │
                        │  picker, feeds, settings│
                        └───────┬─────────┬───────┘
                                │         │ screenshots / diff PNGs
                          Postgres        ▼
                     (users, resources,  artifact store (volume / S3)
                      snapshots, alerts)        ▲
                                ▲               │
  ┌───────────────┐   enqueue   │      ┌────────┴──────────────────────────┐
  │  Scheduler    │ ──────────► Redis  │  Worker (N replicas)               │
  │  (1+ replicas)│  1 job per  BullMQ │  1. SSRF check                     │
  │  SKIP LOCKED  │  Resource   ─────► │  2. per-domain slot (Redis Lua)    │
  └───────────────┘                    │  3. Playwright render + screenshot │
                                       │  4. classify OK/ERROR/404/BLOCKED  │
                                       │  5. selectors + noise filtering    │
                                       │  6. hash vs latest snapshot        │
                                       │  7. store snapshot only if changed │
                                       │  8. enqueue notify job             │
                                       └────────┬──────────────────────────┘
                                                ▼
                                    Notify worker (dispatcher)
                    per-subscriber: volatility, dedupe, keywords, sensitivity,
                    cooldown, digest  ──►  Email / Telegram / Discord / Webhook
```

### Core data model (`prisma/schema.prisma`)

| Model | Purpose |
|---|---|
| `User` | Account, timezone, extension `apiToken` |
| `TrackedUrl` | A user's **subscription**: name, interval, sensitivity, regions, keywords, number rules |
| `Resource` | The **unit of fetching**: one normalized URL + one selector profile. Holds status, schedule, volatility state |
| `Snapshot` | Immutable version of a Resource. Written **only when the content hash changes** |
| `NumberPoint` | Time series for number tracking |
| `AlertSettings` | Channels, digest mode, cooldown, AI summaries |
| `AlertEvent` | Dedupe ledger and digest queue: one row per (subscription, snapshot) decision |

The split between `TrackedUrl` (per user) and `Resource` (shared) is the key design decision: fetching, storage and diffing happen per Resource, while sensitivity, keywords and delivery are decided per subscriber.

---

## Repository structure

```
website-change-detector/
├── README.md
├── LICENSE
├── package.json
├── Dockerfile
├── docker-compose.yml
├── .env.example
├── prisma/
│   └── schema.prisma              # Users, TrackedUrls, Resources, Snapshots, AlertSettings, ...
├── src/
│   ├── config.js
│   ├── db.js
│   ├── api/
│   │   ├── server.js              # app, signed diff/screenshot views, RSS, static dashboard
│   │   ├── routes.js              # authenticated JSON API incl. extension endpoints
│   │   ├── auth.js                # register/login, JWT + extension API token
│   │   ├── service.js             # create/update/delete subscriptions
│   │   └── validation.js          # zod schemas (selector and regex hardening)
│   ├── queue/
│   │   ├── queues.js              # BullMQ queues (checks, notify)
│   │   └── scheduler.js           # claims due Resources, enqueues 1 job each
│   ├── worker/
│   │   ├── index.js               # BullMQ workers, retries, rate-limit rescheduling
│   │   └── scraper.js             # ★ core worker logic
│   ├── alerts/
│   │   ├── dispatcher.js          # fan-out, dedupe, sensitivity, keywords, digest
│   │   ├── channels.js            # email, Telegram, Discord, webhook
│   │   └── ai-summary.js          # one-line LLM summary with safe fallback
│   └── lib/
│       ├── noise-filter.js        # DOM + text noise removal
│       ├── classify.js            # outage / 404 / CAPTCHA detection
│       ├── volatility.js          # alert-loop protection
│       ├── rate-limiter.js        # per-domain Redis limiter
│       ├── diff.js                # text diff, screenshot diff, side-by-side HTML
│       ├── numbers.js             # number parsing
│       ├── keywords.js
│       ├── url.js                 # normalization, SSRF guard
│       ├── resources.js           # find-or-create shared Resource
│       ├── picker.js              # sandboxed page preview for the region picker
│       ├── links.js               # signed diff / image / feed links
│       ├── storage.js
│       └── hash.js
├── web/
│   ├── index.html                 # dashboard (status table, timeline, compare, chart, picker)
│   └── picker.js                  # runs inside the sandboxed preview iframe
├── extension/                     # Manifest V3 companion extension
│   ├── manifest.json
│   ├── popup.html
│   └── popup.js
└── test/
    └── lib.test.js
```

---

## Quick start (Docker Compose)

Requirements: Docker with Compose v2.

```bash
git clone <your-repo-url> website-change-detector
cd website-change-detector

cp .env.example .env
# edit .env: set JWT_SECRET (long random string) and SMTP_* if you want email alerts

docker compose up -d --build
docker compose logs -f api worker scheduler
```

Open <http://localhost:3000>, register an account, and add a page.

Useful commands:

```bash
docker compose up -d --scale worker=4    # more Chromium workers
docker compose exec api npx prisma studio  # inspect the database (dev only)
docker compose down -v                   # stop and delete all data
```

Notes:

* The `migrate` service runs `prisma db push` on start so a fresh clone works immediately. For production, create migrations with `npm run db:dev -- --name init`, commit `prisma/migrations/`, and switch the service to `prisma migrate deploy`.
* Workers set `shm_size: 1gb`; Chromium crashes with the default 64 MB `/dev/shm`.
* Screenshots live in the `artifacts` volume shared by `api` and `worker`. To run them on separate hosts, replace `src/lib/storage.js` (three functions) with an S3/GCS implementation.

---

## Configuration

All settings are environment variables (see `.env.example`).

| Variable | Default | Meaning |
|---|---|---|
| `JWT_SECRET` | – | Signs login tokens **and** alert/diff/RSS links. Required in production |
| `PUBLIC_BASE_URL` | `http://localhost:3000` | Used to build links inside alerts |
| `WORKER_CONCURRENCY` | 4 | Parallel checks per worker process |
| `SCRAPE_TIMEOUT_MS` | 45000 | Navigation timeout; hard job timeout is 2× + 30 s |
| `SCRAPE_ATTEMPTS` | 3 | BullMQ attempts (30 s, 60 s exponential backoff) |
| `DOMAIN_MAX_CONCURRENT` | 2 | Simultaneous fetches per target domain, across all workers |
| `DOMAIN_MIN_GAP_MS` | 3000 | Minimum gap between fetch starts per domain |
| `VOLATILE_MAX_CHANGES` / `VOLATILE_WINDOW_MIN` | 6 / 60 | More than N snapshots in the window flags a page as volatile |
| `SMTP_*` | – | Email delivery |
| `LLM_API_KEY` / `LLM_MODEL` | – / `claude-haiku-5-5` | Enables AI summaries (Anthropic Messages API) |

Check intervals are validated to **15 – 1440 minutes**.

---

## How the four hard problems are solved

### 1. Are outages, 404s and CAPTCHAs "changes"?

**No. They are status changes, never content changes.**

`lib/classify.js` inspects every fetch (HTTP status, page title, visible text, CAPTCHA iframes) and returns one of `OK`, `ERROR` (5xx, timeout, DNS, empty render), `NOT_FOUND` (404/410 and "soft 404" pages served with 200) or `BLOCKED` (403/401/429, Cloudflare/reCAPTCHA/hCaptcha walls, which usually return HTTP 200).

For anything other than `OK`:

* **No snapshot is written** and no content diff is produced. The last good snapshot stays the baseline.
* `Resource.status` / `statusDetail` update, which is what the dashboard shows (OK / error / blocked).
* Transient failures (`ERROR`) are retried by BullMQ with exponential backoff **before** being recorded.
* Failing pages back off exponentially (up to 8× the interval, capped at 24 h) so a dead site is not hammered.
* Users get **one** "page is down / blocked" notice per incident, only after two consecutive failed scheduled runs (filters blips), plus one "recovered" notice.
* When the site returns, the new content is compared with the last good snapshot. A three-hour outage therefore never produces a "changed to 'Service Unavailable' and back" pair of false alerts.
* A watched region that no longer matches anything is reported as an error ("layout may have changed"), not as a change.

CAPTCHAs are **detected, not defeated**. The system does not try to bypass bot protection.

### 2. 200 users, same URL, same interval: fetch once

1. URLs are normalized (`lib/url.js`): lowercase host, tracking params (`utm_*`, `fbclid`, ...) removed, query sorted, fragment and trailing slash dropped.
2. Subscriptions attach to a shared **`Resource`** keyed by `(normalizedUrl, profileHash)`, where `profileHash` is a hash of the sorted watch/ignore selectors. Users watching the whole page share one Resource.
3. The scheduler enqueues **one job per Resource**, with a deterministic `jobId` (`check-<resourceId>`), so BullMQ also ignores accidental duplicates.
4. Effective interval = the shortest interval among active subscribers (`recomputeInterval`). Slower subscribers just receive alerts when changes happen.
5. One fetch → one snapshot (+ screenshot) → the dispatcher fans out to the 200 subscribers, each applying their own sensitivity, keywords and delivery settings.

Different selector profiles on the same URL are separate Resources (each is one fetch). Sensitivity is deliberately **not** part of the key: the stored text uses conservative normalization, and LOW sensitivity re-filters aggressively at alert time, so it never fragments the shared fetch.

### 3. Alert fatigue on pages that differ on every load

Defence in depth, cheapest layer first:

1. **Noise filtering** (`lib/noise-filter.js`): the DOM layer removes ads, carousels, banners, cookie bars, scripts and hidden inputs before text extraction. The text layer masks ISO and clock timestamps, "5 minutes ago", "Updated: ..." lines, view/visitor counters, UUIDs, long hex/base64 session tokens and epoch values.
2. **Hash only normalized content.** The raw hash is stored separately (`rawHash`) so you can measure how noisy a page is.
3. **Sensitivity** (per subscription): `HIGH` any change; `MEDIUM` ≥ 3 changed words **or any changed number**; `LOW` ≥ 10 words and ≥ 2 % of the page, with extra patterns (likes/comments counters, "N left in stock", copyright years).
4. **Volatility detection** (`lib/volatility.js`): more than N snapshots within the window flags the Resource `volatile`. While volatile, lines whose *shape* keeps appearing in recent diffs (digits → `#`, long tokens → `*`) are excluded from the hash and diff, so churn stops creating snapshots, but a real edit to stable content still does. Instant alerts are muted and the user gets **one** "this page is noisy" notice suggesting a watch region. The flag clears when the page calms down.
5. **Dedupe + cooldown**: one `AlertEvent` per `(subscription, content hash, UTC day)` (unique key), and a per-user cooldown (default 60 min) after which extra changes roll into the digest instead of firing individually. A page that flips A → B → A → B alerts once per day, not every flip.

Trade-off: if a legitimately important line also churns constantly, it is masked while the page is volatile. Use the region picker (watch regions) or number tracking, which reads the DOM directly, to target it.

### 4. Not hammering a domain

`lib/rate-limiter.js` is a Redis-backed limiter shared by **all** worker processes:

* At most `DOMAIN_MAX_CONCURRENT` (default 2) simultaneous fetches per domain: a sorted set of live "slots" with TTLs, so a crashed worker can never leak a slot.
* At least `DOMAIN_MIN_GAP_MS` (default 3 s) between fetch starts per domain.
* Both checks run in one Lua script using Redis `TIME`, so they are atomic and immune to worker clock skew.
* If no slot opens within ~20 s, the job is **moved to delayed** (`DelayedError`) instead of blocking a worker thread.
* `429` responses (and `Retry-After`) call `penalize(domain)`, pushing the next-allowed time out for every worker at once.
* The scheduler adds 0–30 s of random jitter so checks don't all fire at `:00`, `:15`, `:30`.

---

## Feature notes

**Region selection.** The dashboard's *Pick regions* button calls `POST /api/picker/prepare`. The server renders the page in Chromium, **strips every script and event handler**, adds a `<base href>`, and returns static HTML that is shown in `<iframe sandbox="allow-scripts" srcdoc>` (no `allow-same-origin`, so the frame cannot reach the dashboard or its tokens). `web/picker.js` highlights on hover, builds a short stable CSS selector on click (prefers `#id`, `data-testid`, stable classes; skips generated class names) and reports it with `postMessage`. Selections are saved as `watchSelectors` / `ignoreSelectors`. If watch regions exist, only those are compared (and the screenshot is cropped to them); ignore regions are always removed.

**Diffing.** `lib/diff.js`: line diff plus a word-level change ratio; `pixelmatch` screenshot diff painted in red (differently sized pages are padded); side-by-side HTML for any two versions (all page text is HTML-escaped; the view is served with a strict CSP).

**Keyword alerts.** Set `keywordsAdded` / `keywordsRemoved`; the subscriber is notified only when a keyword (Unicode whole-word, case-insensitive) appears or disappears between the two versions.

**Number tracking.** `numberRules: [{ "label": "Price", "selector": ".price" }]` or a `regex`. Values are read straight from the DOM, parsed (`$1,299.00`, `1.299,50 €`, `₹74,999`, `4.5k`) and stored in `NumberPoint` only when the value changes. `GET /api/targets/:id/numbers` returns chart-ready series; the dashboard draws them.

**AI summaries.** Optional per user. One LLM call **per snapshot** (shared by all subscribers) turns the added/removed lines into one sentence. Page text is passed as tagged data with an instruction not to follow it, output is length-capped and always HTML-escaped, and any failure falls back to a mechanical summary.

**RSS.** `GET /feeds/:id/:token.xml`: the last 50 changes with summary and signed diff link. The token in the URL is the credential, so any feed reader can subscribe.

**Daily digest.** `mode: DAILY_DIGEST` queues alerts as `PENDING`; an hourly job sends one message when the user's local hour equals `digestHour` (so for half-hour timezones like IST it arrives at hh:30). The same hourly sweep retries failed deliveries and flushes cooldown-deferred alerts.

**Dashboard.** Status per page (OK / ERROR / NOT_FOUND / BLOCKED / PAUSED), last checked, last changed, volatility hint, version count, per-page version timeline, two-version compare and number charts.

---

## API reference

Authenticated routes accept `Authorization: Bearer <jwt>` or `X-API-Token: <token>`.

| Method & path | Description |
|---|---|
| `POST /api/auth/register`, `POST /api/auth/login` | Returns `{ token, apiToken }` |
| `GET /api/targets` | Dashboard list with status fields |
| `POST /api/targets` | Create subscription (see body below) |
| `GET / PATCH / DELETE /api/targets/:id` | Read, edit (including regions), remove |
| `GET /api/targets/:id/versions` | Version timeline |
| `GET /api/targets/:id/compare?from=1&to=4` | Diff of any two versions + signed `viewUrl` |
| `GET /api/targets/:id/numbers` | `{ "Price": [{ "t": ..., "v": 99 }] }` |
| `POST /api/picker/prepare` | `{ url }` → sandbox-safe HTML preview |
| `GET / PUT /api/settings` | Channels, digest mode, cooldown, AI summaries, timezone |
| `GET /diff/:snapshotId?u=&sig=[&from=]` | Side-by-side view (signed, login-free; used in alerts) |
| `GET /feeds/:id/:token.xml` | RSS feed |

```jsonc
// POST /api/targets
{
  "url": "https://example.com/product/42",
  "name": "Example product",
  "intervalMinutes": 60,                  // 15 .. 1440
  "sensitivity": "MEDIUM",                // LOW | MEDIUM | HIGH
  "watchSelectors": ["#price-box"],
  "ignoreSelectors": [".recommendations"],
  "keywordsAdded": ["in stock"],
  "keywordsRemoved": [],
  "numberRules": [{ "label": "Price", "selector": ".price" }]
}
```

### Browser extension endpoints

CORS is open on `/api/extension/*` only; the `X-API-Token` header is the credential (shown in `GET /api/settings`).

| Method & path | Description |
|---|---|
| `GET /api/extension/ping` | Verify token and server |
| `GET /api/extension/lookup?url=` | `{ tracked, target }`, so the popup can show "Already tracking" |
| `POST /api/extension/add` | `{ url, name?, intervalMinutes? }` → `201` created or `200` already tracked (idempotent) |

Load `extension/` as an unpacked extension in Chrome (`chrome://extensions` → *Load unpacked*), open *Connection*, and enter your server URL and API token.

---

## Security model

* **Public pages only.** There is no login or cookie feature; every check uses a fresh, cookie-less browser context.
* **SSRF protection.** Private/loopback/link-local/CGNAT addresses and `.local` / `.internal` hosts are rejected at creation time and again before each fetch, **and** every sub-request and redirect made by the browser is checked (`context.route`). User webhook URLs get the same check; Discord URLs must match Discord's webhook host.
* **Untrusted page content.** Page-derived text is escaped in HTML/email, Telegram is sent without `parse_mode`, Discord messages disable mentions, the LLM prompt treats page text as data, and the picker preview runs scriptless in a sandboxed iframe.
* **Signed links.** Diff, screenshot and feed URLs carry an HMAC bound to the subscription, so they open without login but cannot be guessed or used for other users' pages.
* **Input hardening.** Selectors reject characters that could escape the injected style rule; user regexes are size-limited and checked for nested-quantifier ReDoS patterns.
* **Auth.** bcrypt (cost 12), 7-day JWTs, per-IP limiter on login/register (in-memory; use a Redis limiter behind multiple API replicas).
* **Etiquette.** The user agent carries a `WebsiteChangeDetector/1.0` token, checks are throttled per domain, and `Retry-After` is respected. Check a site's terms before monitoring it at high frequency.

---

## Known limitations and next steps

* No `robots.txt` handling yet; add a per-domain cache consulted by the scheduler.
* Telegram bot tokens and webhook URLs are stored in plaintext in `AlertSettings`; encrypt at rest (e.g. libsodium sealed with a KMS key) before multi-tenant use.
* Selector profile granularity: two users watching different regions of one URL cause two fetches. A "one render, many profiles" optimization is possible.
* Resources with no remaining subscribers are skipped but not deleted; add a retention job for old snapshots and screenshots.
* Volatility masking is heuristic (line shape). Heavily personalised pages (recommendations, A/B tests) are best handled with watch regions.
* Single-process Chromium per worker, recycled every 200 jobs when idle; for large scale run more worker replicas rather than higher concurrency.
* User regexes would be safer under RE2 for hostile multi-tenant use.

---

## Development and tests

```bash
npm install
cp .env.example .env            # point DATABASE_URL / REDIS_URL at local services
npx prisma generate && npx prisma db push
npx playwright install chromium

npm run api         # terminal 1
npm run scheduler   # terminal 2
npm run worker      # terminal 3
npm test            # unit tests (node:test)
```

The tests cover noise normalization, number parsing, keyword matching, URL normalization and profile hashing, SSRF address checks, fetch classification, volatility masking and numeric-change detection.
