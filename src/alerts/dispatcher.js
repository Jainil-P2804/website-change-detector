'use strict';

/**
 * Fan-out from ONE snapshot to MANY subscribers.
 *
 * The scraper stored the snapshot once. Here every subscription decides, with
 * its own settings, whether this change is worth an alert:
 *
 *   volatile page?          -> suppress (alert-fatigue guard)
 *   already told (dedupe)?  -> suppress   key = sub + content hash + UTC day
 *   keyword rules set?      -> alert only if a watched keyword appeared/disappeared
 *   otherwise sensitivity   -> HIGH / MEDIUM / LOW thresholds on the diff
 *   cooldown / digest mode  -> defer to the digest instead of sending now
 */

const crypto = require('node:crypto');
const prisma = require('../db');
const config = require('../config');
const { textDiff, numericChange, describeDiff } = require('../lib/diff');
const { cleanText, isAggressive } = require('../lib/noise-filter');
const { keywordChanges } = require('../lib/keywords');
const { diffLink } = require('../lib/links');
const { summarizeChange } = require('./ai-summary');
const { deliver } = require('./channels');

const DEFAULT_SETTINGS = { mode: 'INSTANT', digestHour: 8, cooldownMinutes: 60, emailEnabled: true, aiSummaries: false };
const settingsOf = (user) => user.alertSettings || { ...DEFAULT_SETTINGS };

function passesSensitivity(diff, sensitivity) {
  const rule = config.sensitivity[sensitivity] || config.sensitivity.MEDIUM;
  if (diff.stats.added + diff.stats.removed === 0) return false;
  if (rule.numeric && numericChange(diff)) return true;
  return diff.changedWords >= rule.minWords && diff.changeRatio >= rule.minRatio;
}

function dedupeKey(subId, contentHash, now = new Date()) {
  const day = now.toISOString().slice(0, 10);
  return crypto.createHash('sha256').update(`${subId}:${contentHash}:${day}`).digest('hex');
}

async function isCoolingDown(subId, minutes) {
  if (!minutes) return false;
  const last = await prisma.alertEvent.findFirst({
    where: { trackedUrlId: subId, state: 'SENT' },
    orderBy: { sentAt: 'desc' },
    select: { sentAt: true },
  });
  return !!last && Date.now() - last.sentAt.getTime() < minutes * 60_000;
}

/* ------------------------------------------------------------------ snapshot */

async function notifySnapshot({ snapshotId, previousSnapshotId }) {
  const snap = await prisma.snapshot.findUnique({ where: { id: snapshotId }, include: { resource: true } });
  const prev = previousSnapshotId ? await prisma.snapshot.findUnique({ where: { id: previousSnapshotId } }) : null;
  if (!snap || !prev) return; // first snapshot = baseline, nothing to announce

  const subs = await prisma.trackedUrl.findMany({
    where: { resourceId: snap.resourceId, paused: false },
    include: { user: { include: { alertSettings: true } } },
  });
  if (!subs.length) return;

  const baseDiff = textDiff(prev.text, snap.text);

  // One LLM call per snapshot, shared by every subscriber who opted in.
  let aiSummary = snap.aiSummary;
  if (!aiSummary && !snap.resource.volatile && subs.some((s) => settingsOf(s.user).aiSummaries)) {
    aiSummary = await summarizeChange({ title: snap.title, added: baseDiff.added, removed: baseDiff.removed });
    await prisma.snapshot.update({ where: { id: snap.id }, data: { aiSummary } });
  }

  for (const sub of subs) {
    const settings = settingsOf(sub.user);
    const verdict = await evaluate(sub, settings, prev, snap, baseDiff, aiSummary);

    let event;
    try {
      event = await prisma.alertEvent.create({
        data: {
          trackedUrlId: sub.id,
          snapshotId: snap.id,
          dedupeKey: dedupeKey(sub.id, snap.contentHash),
          state: verdict.send ? 'PENDING' : 'SUPPRESSED',
          reason: verdict.send ? null : verdict.reason,
          summary: verdict.summary,
        },
      });
    } catch (err) {
      if (err.code === 'P2002') continue; // deduplicated: this subscription already handled this state today
      throw err;
    }
    if (!verdict.send) continue;

    const instant = settings.mode === 'INSTANT' && !(await isCoolingDown(sub.id, settings.cooldownMinutes));
    if (!instant) {
      await prisma.alertEvent.update({ where: { id: event.id }, data: { reason: 'deferred-to-digest' } });
      continue;
    }
    await sendEvents(sub.user, settings, [{ event, sub, snap }]);
  }
}

async function evaluate(sub, settings, prev, snap, baseDiff, aiSummary) {
  if (snap.resource.volatile) return { send: false, reason: 'page-volatile', summary: null };

  const hasKeywords = sub.keywordsAdded.length > 0 || sub.keywordsRemoved.length > 0;
  if (hasKeywords) {
    const kw = keywordChanges(prev.text, snap.text, { added: sub.keywordsAdded, removed: sub.keywordsRemoved });
    if (!kw.appeared.length && !kw.disappeared.length) return { send: false, reason: 'no-keyword-match', summary: null };
    const parts = [];
    if (kw.appeared.length) parts.push(`Keyword appeared: ${kw.appeared.join(', ')}`);
    if (kw.disappeared.length) parts.push(`Keyword disappeared: ${kw.disappeared.join(', ')}`);
    return { send: true, summary: parts.join(' | ') };
  }

  // LOW sensitivity re-normalizes both versions with the aggressive noise patterns.
  const diff = isAggressive(sub.sensitivity)
    ? textDiff(cleanText(prev.text, { aggressive: true }), cleanText(snap.text, { aggressive: true }))
    : baseDiff;
  if (!passesSensitivity(diff, sub.sensitivity)) return { send: false, reason: `below-sensitivity-${sub.sensitivity.toLowerCase()}`, summary: null };

  return { send: true, summary: aiSummary || describeDiff(diff, 2) };
}

/* -------------------------------------------------------------------- sending */

/** entries: [{event, sub, snap}] for ONE user. Marks events SENT only when delivery worked. */
async function sendEvents(user, settings, entries, { digest = false } = {}) {
  const items = entries.map(({ event, sub, snap }) => ({
    kind: 'change',
    page: sub.name,
    url: sub.url,
    summary: event.summary || 'Content changed',
    diffUrl: diffLink(sub.id, snap.id),
  }));
  const res = await deliver(user, settings, items, { digest });
  const ids = entries.map((e) => e.event.id);
  if (res.noChannels) {
    await prisma.alertEvent.updateMany({ where: { id: { in: ids } }, data: { state: 'SUPPRESSED', reason: 'no-channels-configured' } });
  } else if (res.delivered) {
    await prisma.alertEvent.updateMany({ where: { id: { in: ids } }, data: { state: 'SENT', sentAt: new Date() } });
  } else {
    // Stays PENDING; the hourly sweep retries it.
    await prisma.alertEvent.updateMany({ where: { id: { in: ids } }, data: { reason: 'delivery-failed' } });
  }
}

/* ------------------------------------------------------------- status notices */

async function notifyStatus({ resourceId, type, state, detail }) {
  const subs = await prisma.trackedUrl.findMany({
    where: { resourceId, paused: false },
    include: { user: { include: { alertSettings: true } } },
  });
  const labels = { ERROR: 'is unreachable', NOT_FOUND: 'returns "not found"', BLOCKED: 'is blocking automated checks (CAPTCHA / access denied)' };

  for (const sub of subs) {
    const summary =
      type === 'RECOVERED'
        ? 'The page is reachable again. Monitoring resumed; changes during the outage will be compared against the last good version.'
        : `This page ${labels[state] || 'has a problem'}${detail ? ` (${detail})` : ''}. This is NOT counted as a content change; we keep checking and will tell you when it recovers.`;
    await deliver(sub.user, settingsOf(sub.user), [
      { kind: type === 'RECOVERED' ? 'recovered' : 'down', page: sub.name, url: sub.url, summary, diffUrl: null },
    ]);
  }
}

async function notifyVolatile({ resourceId }) {
  const subs = await prisma.trackedUrl.findMany({
    where: { resourceId, paused: false },
    include: { user: { include: { alertSettings: true } } },
  });
  for (const sub of subs) {
    await deliver(sub.user, settingsOf(sub.user), [
      {
        kind: 'volatile',
        page: sub.name,
        url: sub.url,
        summary: 'This page changes on almost every load, so instant alerts are paused to avoid noise. Pick a specific region to watch, or use keywords / number tracking, for precise alerts.',
        diffUrl: null,
      },
    ]);
  }
}

/* ---------------------------------------------------------------------- digest */

function localHour(timezone, now = new Date()) {
  try {
    return parseInt(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hourCycle: 'h23', timeZone: timezone }).format(now), 10);
  } catch {
    return now.getUTCHours();
  }
}

/** Hourly sweep: sends daily digests that are due AND retries deferred / failed instant alerts. */
async function runDigest() {
  const pending = await prisma.alertEvent.findMany({
    where: { state: 'PENDING' },
    include: { trackedUrl: { include: { user: { include: { alertSettings: true } } } }, snapshot: true },
    orderBy: { createdAt: 'asc' },
    take: 5000,
  });

  const byUser = new Map();
  for (const ev of pending) {
    const uid = ev.trackedUrl.userId;
    if (!byUser.has(uid)) byUser.set(uid, []);
    byUser.get(uid).push(ev);
  }

  for (const events of byUser.values()) {
    const user = events[0].trackedUrl.user;
    const settings = settingsOf(user);
    const digestMode = settings.mode === 'DAILY_DIGEST';

    if (digestMode && localHour(user.timezone) !== settings.digestHour) continue;

    const ready = [];
    for (const ev of events) {
      if (!digestMode && (await isCoolingDown(ev.trackedUrlId, settings.cooldownMinutes))) continue;
      ready.push({ event: ev, sub: ev.trackedUrl, snap: ev.snapshot });
    }
    if (ready.length) await sendEvents(user, settings, ready, { digest: digestMode || ready.length > 1 });
  }
}

async function handleNotifyJob(job) {
  switch (job.name) {
    case 'snapshot': return notifySnapshot(job.data);
    case 'status': return notifyStatus(job.data);
    case 'volatile': return notifyVolatile(job.data);
    case 'digest': return runDigest();
    default: console.warn(`[notify] unknown job ${job.name}`);
  }
}

module.exports = { handleNotifyJob, passesSensitivity, dedupeKey };
