'use strict';

/**
 * Core scraping worker logic.
 *
 *   checkResource(resourceId)
 *     1. load the shared Resource (one row per URL + selector profile)
 *     2. SSRF check, then take a per-domain politeness slot (Redis)
 *     3. render the page in headless Chromium (public pages only, fresh
 *        cookie-less context every time - no stored credentials)
 *     4. classify the response: OK / ERROR / NOT_FOUND / BLOCKED
 *        (non-OK states are status changes, never content changes)
 *     5. apply watch / ignore selectors + DOM noise removal, extract text
 *     6. normalize text (timestamps, counters, tokens...) and hash it
 *     7. compare with the latest snapshot; ONLY if the hash differs store a
 *        new Snapshot (+ screenshot, text diff, screenshot diff)
 *     8. record number-tracking points, update volatility + scheduling state
 *
 * It returns a small outcome object; worker/index.js turns that into
 * notification jobs. Fan-out to individual users happens there, so a page
 * tracked by 200 users is fetched and stored exactly once.
 */

const { chromium } = require('playwright');
const prisma = require('../db');
const config = require('../config');
const storage = require('../lib/storage');
const { sha256 } = require('../lib/hash');
const { NOISE_SELECTORS, cleanText } = require('../lib/noise-filter');
const { classifyFetch } = require('../lib/classify');
const { textDiff, screenshotDiff } = require('../lib/diff');
const { extractNumbers } = require('../lib/numbers');
const { assertPublicUrl } = require('../lib/url');
const { buildChurnMask, applyMask, assessVolatility } = require('../lib/volatility');

const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 WebsiteChangeDetector/1.0';
const STATUS_ALERT_AFTER = 2; // consecutive failed scheduled runs before a "page is down" notice
const MAX_SCREENSHOT_HEIGHT = 10000;
const MAX_DIFF_LINES = 200;

class RetryableFetchError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RetryableFetchError';
  }
}

/* ------------------------------------------------------------------ browser */

let browserPromise = null;
let activeContexts = 0;
let launchesJobs = 0;

async function getBrowser() {
  // Recycle Chromium periodically to bound memory growth, but only when idle.
  if (browserPromise && launchesJobs >= 200 && activeContexts === 0) {
    const old = browserPromise;
    browserPromise = null;
    launchesJobs = 0;
    old.then((b) => b.close()).catch(() => {});
  }
  if (!browserPromise) {
    browserPromise = chromium
      .launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
      .then((b) => {
        b.on('disconnected', () => {
          browserPromise = null;
        });
        return b;
      })
      .catch((err) => {
        browserPromise = null;
        throw err;
      });
  }
  return browserPromise;
}

async function closeBrowser() {
  if (!browserPromise) return;
  const b = await browserPromise.catch(() => null);
  browserPromise = null;
  if (b) await b.close().catch(() => {});
}

/* -------------------------------------------------- in-page helper functions */
// These two functions are serialized and executed INSIDE the page, so they must
// not reference anything from the surrounding module scope.

function prepareInPage({ noiseSel, ignoreSel, watchSel, numberSel }) {
  const valid = (list) =>
    list.filter((s) => {
      try {
        document.querySelector(s);
        return true;
      } catch {
        return false;
      }
    });

  const result = {
    title: document.title || '',
    hasCaptchaFrame: !!document.querySelector(
      'iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="challenges.cloudflare.com"], .g-recaptcha, .h-captcha, #cf-challenge-running'
    ),
    numbersRaw: {},
    watchMatched: 0,
    clip: null,
    pageHeight: Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0),
  };

  // Number tracking reads the untouched DOM (the value may live in an "ad-like" widget).
  for (const sel of valid(numberSel)) {
    result.numbersRaw[sel] = Array.from(document.querySelectorAll(sel))
      .slice(0, 5)
      .map((el) => (el.innerText || el.textContent || '').trim());
  }

  const watchSelectors = valid(watchSel);
  const roots = [];
  for (const sel of watchSelectors) roots.push(...document.querySelectorAll(sel));
  result.watchMatched = roots.length;

  // If the user picked explicit watch regions, their choice wins over the generic
  // noise list (they may deliberately watch a banner). Ignore regions always apply.
  const hide = watchSelectors.length ? valid(ignoreSel) : valid([...noiseSel, ...ignoreSel]);
  if (hide.length) {
    const style = document.createElement('style');
    style.textContent = `${hide.join(',')}{visibility:hidden !important}`;
    document.documentElement.appendChild(style);
  }

  if (roots.length) {
    let x1 = Infinity, y1 = Infinity, x2 = 0, y2 = 0;
    for (const el of roots) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      x1 = Math.min(x1, r.left + window.scrollX);
      y1 = Math.min(y1, r.top + window.scrollY);
      x2 = Math.max(x2, r.right + window.scrollX);
      y2 = Math.max(y2, r.bottom + window.scrollY);
    }
    if (x2 > x1 && y2 > y1) {
      result.clip = { x: Math.max(0, x1), y: Math.max(0, y1), width: Math.ceil(x2 - x1), height: Math.ceil(y2 - y1) };
    }
  }
  return result;
}

function extractInPage({ noiseSel, ignoreSel, watchSel }) {
  const valid = (list) =>
    list.filter((s) => {
      try {
        document.querySelector(s);
        return true;
      } catch {
        return false;
      }
    });
  const watchSelectors = valid(watchSel);
  const roots = [];
  for (const sel of watchSelectors) roots.push(...document.querySelectorAll(sel));

  // Physically remove ignored / noisy nodes so they can't leak into the text.
  const remove = watchSelectors.length ? valid(ignoreSel) : valid([...noiseSel, ...ignoreSel]);
  for (const sel of remove) document.querySelectorAll(sel).forEach((el) => el.remove());

  const targets = roots.length ? roots.filter((r) => r.isConnected) : [document.body];
  return targets.map((el) => el.innerText || '').join('\n');
}

/* ----------------------------------------------------------------- rendering */

async function renderPage({ url, watch, ignore, numberSelectors }) {
  const browser = await getBrowser();
  activeContexts++;
  launchesJobs++;
  const context = await browser.newContext({
    userAgent: USER_AGENT,
    viewport: { width: 1366, height: 900 },
    locale: 'en-US',
    serviceWorkers: 'block',
    acceptDownloads: false,
  });

  try {
    // Block any sub-request (including redirects) that resolves to a private address.
    const hostVerdicts = new Map();
    await context.route('**/*', async (route) => {
      let u;
      try {
        u = new URL(route.request().url());
      } catch {
        return route.abort('blockedbyclient');
      }
      if (['data:', 'blob:', 'about:'].includes(u.protocol)) return route.continue();
      if (!hostVerdicts.has(u.hostname)) {
        hostVerdicts.set(u.hostname, assertPublicUrl(u.toString()).then(() => true, () => false));
      }
      return (await hostVerdicts.get(u.hostname)) ? route.continue() : route.abort('blockedbyclient');
    });

    const page = await context.newPage();
    let response = null;
    try {
      response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: config.worker.scrapeTimeoutMs });
      await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {}); // best effort
      await page.waitForTimeout(800); // let late hydration settle
    } catch (err) {
      return { navError: String(err.message || err).split('\n')[0] };
    }

    const headers = response ? response.headers() : {};
    const args = { noiseSel: NOISE_SELECTORS, ignoreSel: ignore, watchSel: watch, numberSel: numberSelectors };
    const prep = await page.evaluate(prepareInPage, args);

    const shotOpts = { type: 'png', animations: 'disabled', caret: 'hide', fullPage: true };
    if (prep.clip) {
      shotOpts.clip = { ...prep.clip, height: Math.min(prep.clip.height, MAX_SCREENSHOT_HEIGHT) };
    } else if (prep.pageHeight > MAX_SCREENSHOT_HEIGHT) {
      shotOpts.clip = { x: 0, y: 0, width: 1366, height: MAX_SCREENSHOT_HEIGHT };
    }
    const screenshot = await page.screenshot(shotOpts);
    const text = await page.evaluate(extractInPage, args);

    return {
      httpStatus: response ? response.status() : null,
      retryAfterSec: headers['retry-after'] ? parseInt(headers['retry-after'], 10) : null,
      title: prep.title,
      hasCaptchaFrame: prep.hasCaptchaFrame,
      watchMatched: prep.watchMatched,
      numbersRaw: prep.numbersRaw,
      screenshot,
      text,
    };
  } finally {
    await context.close().catch(() => {});
    activeContexts--;
  }
}

/* ---------------------------------------------------------------- scheduling */

/** Failing pages back off exponentially so we don't keep hitting a dead site. */
function nextDelayMs(intervalMinutes, consecutiveErrors) {
  const base = intervalMinutes * 60_000;
  if (consecutiveErrors < 3) return base;
  const factor = Math.min(2 ** (consecutiveErrors - 2), 8);
  return Math.min(base * factor, Math.max(base, 24 * 3600_000));
}

/* ------------------------------------------------------------- state updates */

async function recordNonOk(resource, verdict, httpStatus) {
  const errors = resource.consecutiveErrors + 1;
  await prisma.resource.update({
    where: { id: resource.id },
    data: {
      status: verdict.state,
      statusDetail: verdict.detail,
      lastHttpStatus: httpStatus ?? null,
      lastCheckedAt: new Date(),
      consecutiveErrors: errors,
      nextCheckAt: new Date(Date.now() + nextDelayMs(resource.intervalMinutes, errors)),
    },
  });
  // Exactly one "page is down/blocked" notice per incident, and only once it
  // has failed on two separate scheduled runs (filters out one-off blips).
  const statusEvent =
    errors === STATUS_ALERT_AFTER ? { type: 'DOWN', state: verdict.state, detail: verdict.detail } : null;
  return { changed: false, status: verdict.state, statusEvent };
}

async function saveNumbers(resource, rules, probe, normalizedText) {
  if (!rules.length) return;
  const points = extractNumbers(rules, probe.numbersRaw, normalizedText);
  for (const p of points) {
    // Storage optimisation: only write a point when the value changed.
    const last = await prisma.numberPoint.findFirst({
      where: { resourceId: resource.id, label: p.label },
      orderBy: { capturedAt: 'desc' },
    });
    if (!last || last.value !== p.value) {
      await prisma.numberPoint.create({ data: { resourceId: resource.id, ...p } });
    }
  }
}

/* ---------------------------------------------------------------- main entry */

/**
 * @param {string} resourceId
 * @param {{limiter: import('../lib/rate-limiter').DomainLimiter, isLastAttempt?: boolean}} opts
 */
async function checkResource(resourceId, { limiter, isLastAttempt = true }) {
  const resource = await prisma.resource.findUnique({
    where: { id: resourceId },
    include: { subscribers: { where: { paused: false }, select: { numberRules: true } } },
  });
  if (!resource) return { skipped: 'resource-deleted' };
  if (resource.subscribers.length === 0) return { skipped: 'no-active-subscribers' };

  // Union of all subscribers' number-tracking rules (deduplicated).
  const ruleMap = new Map();
  for (const s of resource.subscribers) {
    for (const r of Array.isArray(s.numberRules) ? s.numberRules : []) {
      ruleMap.set(`${r.label}|${r.selector || ''}|${r.regex || ''}`, r);
    }
  }
  const rules = [...ruleMap.values()];
  const numberSelectors = [...new Set(rules.map((r) => r.selector).filter(Boolean))];

  try {
    await assertPublicUrl(resource.normalizedUrl);
  } catch (err) {
    return recordNonOk(resource, { state: 'ERROR', detail: `Target not allowed: ${err.message}` }, null);
  }

  // Throws RateLimitedError if the domain is saturated; the worker reschedules.
  const release = await limiter.acquire(resource.domain);
  let probe;
  try {
    probe = await renderPage({
      url: resource.normalizedUrl,
      watch: resource.watchSelectors,
      ignore: resource.ignoreSelectors,
      numberSelectors,
    });
  } finally {
    await release();
  }

  // Politeness: honour Retry-After / 429 for ALL workers via the shared limiter.
  if (probe.httpStatus === 429) {
    const ms = Math.min((probe.retryAfterSec || 300) * 1000, 3600_000);
    await limiter.penalize(resource.domain, ms);
  }

  /* ---- 4. classify: is this even a real page? ---- */
  let verdict = probe.navError
    ? classifyFetch({ navError: probe.navError })
    : classifyFetch({
        httpStatus: probe.httpStatus,
        title: probe.title,
        text: probe.text,
        hasCaptchaFrame: probe.hasCaptchaFrame,
      });
  if (verdict.state === 'OK' && resource.watchSelectors.length && probe.watchMatched === 0) {
    verdict = { state: 'ERROR', detail: 'Watched region not found - the page layout may have changed', retryable: false };
  }
  if (verdict.state !== 'OK') {
    if (verdict.retryable && !isLastAttempt) throw new RetryableFetchError(verdict.detail); // BullMQ backs off + retries
    return recordNonOk(resource, verdict, probe.httpStatus);
  }

  /* ---- 5/6. normalize + hash ---- */
  const normalized = cleanText(probe.text);
  const prev = resource.latestSnapshotId
    ? await prisma.snapshot.findUnique({ where: { id: resource.latestSnapshotId } })
    : null;

  // While a page is flagged volatile, lines that keep churning are excluded from the comparison.
  let mask = null;
  if (resource.volatile && prev) {
    const recent = await prisma.snapshot.findMany({
      where: { resourceId: resource.id },
      orderBy: { version: 'desc' },
      take: 6,
      select: { diffFromPrev: true },
    });
    mask = buildChurnMask(recent.map((s) => s.diffFromPrev).filter(Boolean));
  }
  const effectiveNew = applyMask(normalized, mask);
  const effectivePrev = prev ? applyMask(prev.text, mask) : null;
  const contentHash = sha256(effectiveNew);
  const prevHash = effectivePrev === null ? null : sha256(effectivePrev);

  const now = new Date();
  const recovered =
    resource.status !== 'OK' && resource.consecutiveErrors >= STATUS_ALERT_AFTER
      ? { type: 'RECOVERED', previous: resource.status }
      : null;
  const baseUpdate = {
    status: 'OK',
    statusDetail: null,
    consecutiveErrors: 0,
    lastCheckedAt: now,
    lastHttpStatus: probe.httpStatus,
    nextCheckAt: new Date(now.getTime() + resource.intervalMinutes * 60_000),
  };

  /* ---- 7a. unchanged: store nothing but bookkeeping ---- */
  if (prevHash === contentHash) {
    const vol = assessVolatility(resource.recentChangeLog, false, resource.volatile, config.volatile, now);
    await prisma.resource.update({
      where: { id: resource.id },
      data: {
        ...baseUpdate,
        recentChangeLog: vol.log,
        volatile: vol.volatile,
        volatileSince: vol.volatile ? resource.volatileSince : null,
      },
    });
    await saveNumbers(resource, rules, probe, normalized);
    return { changed: false, status: 'OK', statusEvent: recovered };
  }

  /* ---- 7b. changed (or first ever check): persist a new snapshot ---- */
  const version = (prev ? prev.version : 0) + 1;
  const screenshotPath = await storage.save(`${resource.id}/v${version}.png`, probe.screenshot);
  const diff = prev ? textDiff(effectivePrev, effectiveNew) : null;
  const vol = assessVolatility(resource.recentChangeLog, !!prev, resource.volatile, config.volatile, now);
  const becameVolatile = vol.volatile && !resource.volatile;

  let snapshot;
  try {
    snapshot = await prisma.$transaction(async (tx) => {
      const s = await tx.snapshot.create({
        data: {
          resourceId: resource.id,
          version,
          contentHash,
          rawHash: sha256(probe.text),
          text: normalized,
          textBytes: Buffer.byteLength(normalized),
          screenshotPath,
          httpStatus: probe.httpStatus,
          title: probe.title.slice(0, 300),
          changeRatio: diff ? diff.changeRatio : null,
          diffFromPrev: diff
            ? { added: diff.added.slice(0, MAX_DIFF_LINES), removed: diff.removed.slice(0, MAX_DIFF_LINES), stats: diff.stats }
            : undefined,
        },
      });
      await tx.resource.update({
        where: { id: resource.id },
        data: {
          ...baseUpdate,
          latestSnapshotId: s.id,
          lastChangedAt: prev ? now : resource.lastChangedAt,
          recentChangeLog: vol.log,
          volatile: vol.volatile,
          volatileSince: becameVolatile ? now : vol.volatile ? resource.volatileSince : null,
        },
      });
      return s;
    });
  } catch (err) {
    if (err.code === 'P2002') return { changed: false, raced: true }; // another worker stored this version first
    throw err;
  }

  // Highlighted screenshot diff (best effort; never fails the check).
  if (prev && prev.screenshotPath) {
    try {
      const sd = await screenshotDiff(storage.abs(prev.screenshotPath), storage.abs(screenshotPath));
      const diffPath = await storage.save(`${resource.id}/diff-v${prev.version}-v${version}.png`, sd.png);
      await prisma.snapshot.update({ where: { id: snapshot.id }, data: { screenshotDiffPath: diffPath } });
    } catch (err) {
      console.warn(`[scraper] screenshot diff failed for ${resource.id}: ${err.message}`);
    }
  }

  await saveNumbers(resource, rules, probe, normalized);

  return {
    changed: !!prev,
    baseline: !prev, // first snapshot establishes the baseline, nobody is alerted
    status: 'OK',
    snapshotId: snapshot.id,
    previousSnapshotId: prev ? prev.id : null,
    becameVolatile,
    statusEvent: recovered,
  };
}

module.exports = { checkResource, closeBrowser, RetryableFetchError, nextDelayMs };
