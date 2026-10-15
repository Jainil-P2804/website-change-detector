'use strict';

/**
 * Visual region picker backend.
 *
 * Renders the target page in headless Chromium, strips ALL of the page's own
 * scripts and handlers, and returns a static HTML document with `<base href>`
 * (so CSS and images still load) plus our picker script (web/picker.js).
 * The dashboard shows it inside <iframe sandbox="allow-scripts" srcdoc=...>:
 * without allow-same-origin the frame cannot touch the dashboard, cookies or
 * tokens, and the picker talks to the dashboard only via postMessage.
 */

const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { assertPublicUrl, normalizeUrl } = require('./url');

const PICKER_JS = fs.readFileSync(path.join(__dirname, '../../web/picker.js'), 'utf8');
let browserPromise = null;

function browser() {
  if (!browserPromise) {
    browserPromise = chromium
      .launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
      .catch((e) => {
        browserPromise = null;
        throw e;
      });
  }
  return browserPromise;
}

async function renderForPicker(inputUrl) {
  const url = normalizeUrl(inputUrl);
  await assertPublicUrl(url);

  const context = await (await browser()).newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
  try {
    const verdicts = new Map();
    await context.route('**/*', async (route) => {
      let u;
      try { u = new URL(route.request().url()); } catch { return route.abort(); }
      if (['data:', 'blob:', 'about:'].includes(u.protocol)) return route.continue();
      if (!verdicts.has(u.hostname)) verdicts.set(u.hostname, assertPublicUrl(u.toString()).then(() => true, () => false));
      return (await verdicts.get(u.hostname)) ? route.continue() : route.abort('blockedbyclient');
    });

    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => {});

    const html = await page.evaluate((base) => {
      document.querySelectorAll('script, noscript, iframe, object, embed, meta[http-equiv], link[rel=preload], link[rel=modulepreload]').forEach((n) => n.remove());
      document.querySelectorAll('*').forEach((el) => {
        for (const a of Array.from(el.attributes)) if (/^on/i.test(a.name)) el.removeAttribute(a.name);
        if (el.tagName === 'A') el.removeAttribute('href'); // clicking must select, never navigate
        if (el.tagName === 'FORM') el.removeAttribute('action');
      });
      const head = document.head || document.documentElement.insertBefore(document.createElement('head'), document.body);
      const b = document.createElement('base');
      b.href = base;
      head.prepend(b);
      return '<!doctype html>' + document.documentElement.outerHTML;
    }, page.url());

    return html.replace('</body>', `<script>${PICKER_JS.replace(/<\/script/gi, '<\\/script')}</script></body>`);
  } finally {
    await context.close().catch(() => {});
  }
}

module.exports = { renderForPicker };
