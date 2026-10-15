'use strict';

const path = require('node:path');
const express = require('express');
const RSS = require('rss');
const { ZodError } = require('zod');
const prisma = require('../db');
const config = require('../config');
const storage = require('../lib/storage');
const { textDiff, describeDiff, renderSideBySideHtml } = require('../lib/diff');
const { verifyDiffLink, shotLink, feedToken, diffLink } = require('../lib/links');
const { register, login, windowLimiter } = require('./auth');
const routes = require('./routes');
const { HttpError } = require('./service');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '100kb' }));

// Express 4 does not catch async errors by itself; wrap every handler.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/* CORS only for the browser-extension endpoints (token auth, no cookies). */
app.use('/api/extension', (req, res, next) => {
  res.set({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, X-API-Token',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  });
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

/* ---------------------------------------------------------------- auth */
const authLimit = windowLimiter({ max: 10, windowMs: 60_000 });
app.post('/api/auth/register', authLimit, wrap(register));
app.post('/api/auth/login', authLimit, wrap(login));

/* ------------------------------------------ authenticated JSON API */
app.use('/api', patchAsync(routes));

/** Makes every route handler in a Router forward rejected promises to next(). */
function patchAsync(router) {
  for (const layer of router.stack) {
    if (!layer.route) continue;
    for (const l of layer.route.stack) {
      const fn = l.handle;
      if (fn.length <= 3) l.handle = (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
    }
  }
  return router;
}

/* ------------------------------------ signed, login-free views (alert links) */

const SAFE_HEADERS = {
  'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

/** Side-by-side diff of a snapshot against the previous (or ?from=<version>) one. */
app.get('/diff/:snapshotId', wrap(async (req, res) => {
  const { u, sig, from } = req.query;
  if (!verifyDiffLink(u, req.params.snapshotId, sig)) return res.status(403).send('Invalid or expired link');

  const sub = await prisma.trackedUrl.findUnique({ where: { id: String(u) } });
  const to = await prisma.snapshot.findUnique({ where: { id: req.params.snapshotId } });
  if (!sub || !to || to.resourceId !== sub.resourceId) return res.status(404).send('Not found');

  const fromVersion = from ? parseInt(from, 10) : to.version - 1;
  const left = Number.isInteger(fromVersion)
    ? await prisma.snapshot.findUnique({ where: { resourceId_version: { resourceId: to.resourceId, version: fromVersion } } })
    : null;
  if (!left) return res.status(404).send('There is no earlier version to compare with.');

  const hasHighlight = left.version === to.version - 1 && to.screenshotDiffPath;
  const html = renderSideBySideHtml({
    title: sub.name,
    left: { version: left.version, createdAt: left.createdAt.toISOString(), text: left.text, shotUrl: left.screenshotPath ? shotLink(sub.id, left.id) : null },
    right: { version: to.version, createdAt: to.createdAt.toISOString(), text: to.text, shotUrl: to.screenshotPath ? shotLink(sub.id, to.id) : null },
    highlightUrl: hasHighlight ? shotLink(sub.id, to.id, 'diff') : null,
  });
  res.set(SAFE_HEADERS).type('html').send(html);
}));

app.get('/shots/:snapshotId', wrap(async (req, res) => {
  const { u, sig, kind } = req.query;
  if (!verifyDiffLink(u, req.params.snapshotId, sig)) return res.status(403).end();
  const sub = await prisma.trackedUrl.findUnique({ where: { id: String(u) } });
  const snap = await prisma.snapshot.findUnique({ where: { id: req.params.snapshotId } });
  if (!sub || !snap || snap.resourceId !== sub.resourceId) return res.status(404).end();
  const rel = kind === 'diff' ? snap.screenshotDiffPath : snap.screenshotPath;
  if (!rel) return res.status(404).end();
  res.set({ 'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff' }).type('png').sendFile(storage.abs(rel));
}));

/** Per-page RSS feed of detected changes. The token in the URL is the credential. */
app.get('/feeds/:id/:token.xml', wrap(async (req, res) => {
  const { id, token } = req.params;
  if (token !== feedToken(id)) return res.status(403).send('Forbidden');
  const sub = await prisma.trackedUrl.findUnique({ where: { id } });
  if (!sub) return res.status(404).send('Not found');

  const snaps = await prisma.snapshot.findMany({
    where: { resourceId: sub.resourceId, version: { gt: 1 } },
    orderBy: { version: 'desc' },
    take: 50,
  });

  const feed = new RSS({
    title: `Changes: ${sub.name}`,
    description: `Detected changes on ${sub.url}`,
    feed_url: `${config.publicBaseUrl}/feeds/${id}/${token}.xml`,
    site_url: sub.url,
    ttl: Math.max(sub.intervalMinutes, 15),
  });
  for (const s of snaps) {
    const d = s.diffFromPrev || { added: [], removed: [] };
    const summary = s.aiSummary || describeDiff(d, 3);
    feed.item({
      title: `${sub.name} changed (v${s.version})`,
      description: String(summary).replace(/]]>/g, ']] >'),
      url: diffLink(sub.id, s.id),
      guid: s.id,
      date: s.createdAt,
    });
  }
  res.type('application/rss+xml').send(feed.xml({ indent: true }));
}));

/* --------------------------------------------------------- static dashboard */
app.use(express.static(path.join(__dirname, '../../web'), { index: 'index.html', extensions: ['html'] }));

app.get('/healthz', (req, res) => res.json({ ok: true }));

/* -------------------------------------------------------------- errors */
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err instanceof ZodError) return res.status(400).json({ error: 'Validation failed', issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  console.error('[api]', err);
  res.status(500).json({ error: 'Internal error' });
});

if (require.main === module) {
  app.listen(config.port, () => console.log(`[api] listening on :${config.port}`));
}

module.exports = app;
