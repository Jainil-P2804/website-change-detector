'use strict';

const express = require('express');
const prisma = require('../db');
const config = require('../config');
const { requireAuth } = require('./auth');
const { HttpError, createTarget, updateTarget, deleteTarget } = require('./service');
const v = require('./validation');
const { textDiff } = require('../lib/diff');
const { diffLink, feedToken } = require('../lib/links');
const { assertPublicUrl, normalizeUrl } = require('../lib/url');
const { validateDiscordUrl } = require('../alerts/channels');
const { renderForPicker } = require('../lib/picker');

const router = express.Router();
router.use(requireAuth);

const feedUrl = (id) => `${config.publicBaseUrl}/feeds/${id}/${feedToken(id)}.xml`;

/** Shape one subscription + its shared Resource state for the dashboard. */
function present(t) {
  const r = t.resource;
  return {
    id: t.id,
    name: t.name,
    url: t.url,
    intervalMinutes: t.intervalMinutes,
    sensitivity: t.sensitivity,
    paused: t.paused,
    watchSelectors: t.watchSelectors,
    ignoreSelectors: t.ignoreSelectors,
    keywordsAdded: t.keywordsAdded,
    keywordsRemoved: t.keywordsRemoved,
    numberRules: t.numberRules || [],
    status: t.paused ? 'PAUSED' : r.status, // OK | ERROR | NOT_FOUND | BLOCKED | PENDING
    statusDetail: r.statusDetail,
    volatile: r.volatile,
    lastCheckedAt: r.lastCheckedAt,
    lastChangedAt: r.lastChangedAt,
    versions: r._count ? r._count.snapshots : undefined,
    feedUrl: feedUrl(t.id),
  };
}

const withResource = { resource: { include: { _count: { select: { snapshots: true } } } } };

/* ------------------------------------------------------------------ targets */

router.get('/targets', async (req, res) => {
  const rows = await prisma.trackedUrl.findMany({
    where: { userId: req.user.id },
    include: withResource,
    orderBy: { createdAt: 'desc' },
  });
  res.json(rows.map(present));
});

router.post('/targets', async (req, res) => {
  const { target, created } = await createTarget(req.user.id, v.targetCreate.parse(req.body));
  const full = await prisma.trackedUrl.findUnique({ where: { id: target.id }, include: withResource });
  res.status(created ? 201 : 200).json(present(full));
});

async function owned(req) {
  const t = await prisma.trackedUrl.findFirst({ where: { id: req.params.id, userId: req.user.id }, include: withResource });
  if (!t) throw new HttpError(404, 'Not found');
  return t;
}

router.get('/targets/:id', async (req, res) => res.json(present(await owned(req))));

router.patch('/targets/:id', async (req, res) => {
  await updateTarget(req.user.id, req.params.id, v.targetUpdate.parse(req.body));
  res.json(present(await owned(req)));
});

router.delete('/targets/:id', async (req, res) => {
  await deleteTarget(req.user.id, req.params.id);
  res.status(204).end();
});

/* ------------------------------------------------ version timeline + compare */

router.get('/targets/:id/versions', async (req, res) => {
  const t = await owned(req);
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
  const snaps = await prisma.snapshot.findMany({
    where: { resourceId: t.resourceId },
    orderBy: { version: 'desc' },
    take: limit,
    select: { id: true, version: true, createdAt: true, changeRatio: true, aiSummary: true, title: true, diffFromPrev: true, screenshotPath: true },
  });
  res.json(
    snaps.map((s) => ({
      id: s.id,
      version: s.version,
      createdAt: s.createdAt,
      title: s.title,
      changeRatio: s.changeRatio,
      summary: s.aiSummary || null,
      stats: s.diffFromPrev ? s.diffFromPrev.stats : null,
      hasScreenshot: !!s.screenshotPath,
      diffUrl: s.version > 1 ? diffLink(t.id, s.id) : null,
    }))
  );
});

/** Compare ANY two versions: JSON diff + a signed link to the side-by-side HTML view. */
router.get('/targets/:id/compare', async (req, res) => {
  const t = await owned(req);
  const from = parseInt(req.query.from, 10);
  const to = parseInt(req.query.to, 10);
  if (!Number.isInteger(from) || !Number.isInteger(to)) throw new HttpError(400, 'from and to must be version numbers');

  const [a, b] = await Promise.all([
    prisma.snapshot.findUnique({ where: { resourceId_version: { resourceId: t.resourceId, version: from } } }),
    prisma.snapshot.findUnique({ where: { resourceId_version: { resourceId: t.resourceId, version: to } } }),
  ]);
  if (!a || !b) throw new HttpError(404, 'Version not found');

  const d = textDiff(a.text, b.text);
  res.json({
    from: { version: a.version, createdAt: a.createdAt },
    to: { version: b.version, createdAt: b.createdAt },
    added: d.added.slice(0, 500),
    removed: d.removed.slice(0, 500),
    changeRatio: d.changeRatio,
    viewUrl: `${diffLink(t.id, b.id)}&from=${a.version}`,
  });
});

/* ------------------------------------------------------------ number tracking */

router.get('/targets/:id/numbers', async (req, res) => {
  const t = await owned(req);
  const wanted = new Set((Array.isArray(t.numberRules) ? t.numberRules : []).map((r) => r.label));
  const rows = await prisma.numberPoint.findMany({
    where: { resourceId: t.resourceId, ...(req.query.label ? { label: String(req.query.label) } : {}) },
    orderBy: { capturedAt: 'asc' },
    take: 5000,
  });
  const series = {};
  for (const p of rows) {
    if (wanted.size && !wanted.has(p.label)) continue;
    (series[p.label] ||= []).push({ t: p.capturedAt, v: p.value });
  }
  res.json(series); // { "Price": [{t, v}, ...] } ready for any chart library
});

/* ------------------------------------------------------------ visual picker */

router.post('/picker/prepare', async (req, res) => {
  const { url } = req.body || {};
  if (typeof url !== 'string') throw new HttpError(400, 'url required');
  try {
    res.json({ html: await renderForPicker(url) });
  } catch (err) {
    throw new HttpError(422, `Could not render page: ${err.message}`);
  }
});

/* ------------------------------------------------------------------ settings */

router.get('/settings', async (req, res) => {
  const s = await prisma.alertSettings.findUnique({ where: { userId: req.user.id } });
  res.json({ ...s, timezone: req.user.timezone, apiToken: req.user.apiToken });
});

router.put('/settings', async (req, res) => {
  const { timezone, ...data } = v.settingsUpdate.parse(req.body);
  try {
    if (data.discordWebhookUrl) validateDiscordUrl(data.discordWebhookUrl);
    if (data.genericWebhookUrl) await assertPublicUrl(data.genericWebhookUrl);
  } catch (err) {
    throw new HttpError(400, err.message);
  }
  if (timezone) {
    try {
      new Intl.DateTimeFormat('en', { timeZone: timezone });
    } catch {
      throw new HttpError(400, 'Unknown timezone');
    }
    await prisma.user.update({ where: { id: req.user.id }, data: { timezone } });
  }
  const s = await prisma.alertSettings.upsert({ where: { userId: req.user.id }, update: data, create: { userId: req.user.id, ...data } });
  res.json(s);
});

/* ----------------------------------------------------- browser extension API */
// Auth: `X-API-Token: <user.apiToken>` (see Settings). CORS is opened for these
// paths only in server.js; the token, not cookies, is the credential.

router.get('/extension/ping', (req, res) => res.json({ ok: true, email: req.user.email }));

/** Is the current page already tracked? (lets the popup show "Tracking" vs "Track this page") */
router.get('/extension/lookup', async (req, res) => {
  let normalized;
  try {
    normalized = normalizeUrl(String(req.query.url || ''));
  } catch {
    throw new HttpError(400, 'Invalid url');
  }
  const resource = await prisma.resource.findFirst({ where: { normalizedUrl: normalized, profileHash: '' } });
  const t = resource ? await prisma.trackedUrl.findFirst({ where: { userId: req.user.id, resourceId: resource.id }, include: withResource }) : null;
  res.json({ tracked: !!t, target: t ? present(t) : null });
});

/** One-click add. Idempotent: adding an already-tracked page returns 200 with the existing target. */
router.post('/extension/add', async (req, res) => {
  const body = v.extensionAdd.parse(req.body);
  const input = v.targetCreate.parse({
    url: body.url,
    name: body.name || new URL(body.url).hostname,
    intervalMinutes: body.intervalMinutes ?? 60,
  });
  const { target, created } = await createTarget(req.user.id, input);
  const full = await prisma.trackedUrl.findUnique({ where: { id: target.id }, include: withResource });
  res.status(created ? 201 : 200).json({ created, target: present(full) });
});

module.exports = router;
