'use strict';

const prisma = require('../db');
const config = require('../config');
const { normalizeUrl, domainOf, profileHash, assertPublicUrl } = require('./url');

/**
 * Finds or creates the shared Resource for (normalized URL, selector profile).
 * This is the heart of Edge Case #2: 200 users who add the same page end up
 * pointing at ONE Resource row, which the scheduler fetches ONCE per interval.
 */
async function findOrCreateResource({ url, watchSelectors = [], ignoreSelectors = [] }) {
  const normalizedUrl = normalizeUrl(url);
  await assertPublicUrl(normalizedUrl);
  const hash = profileHash(watchSelectors, ignoreSelectors);

  const clean = (a) => [...new Set(a.map((s) => s.trim()).filter(Boolean))].sort();
  return prisma.resource.upsert({
    where: { normalizedUrl_profileHash: { normalizedUrl, profileHash: hash } },
    update: {},
    create: {
      normalizedUrl,
      domain: domainOf(normalizedUrl),
      profileHash: hash,
      watchSelectors: clean(watchSelectors),
      ignoreSelectors: clean(ignoreSelectors),
      intervalMinutes: config.interval.maxMinutes,
    },
  });
}

/**
 * The effective check interval of a Resource is the SHORTEST interval any
 * active subscriber asked for. Slower subscribers simply receive the
 * "latest snapshot" data at their own pace (alerts are per subscription).
 * Call after any subscription is created, edited, paused or deleted.
 */
async function recomputeInterval(resourceId) {
  const agg = await prisma.trackedUrl.aggregate({
    where: { resourceId, paused: false },
    _min: { intervalMinutes: true },
  });
  const minutes = agg._min.intervalMinutes;
  if (!minutes) return; // no active subscribers: scheduler skips it
  const res = await prisma.resource.findUnique({ where: { id: resourceId }, select: { intervalMinutes: true, nextCheckAt: true } });
  const patch = { intervalMinutes: minutes };
  // If the interval got shorter, pull the next check forward accordingly.
  const latestAllowed = new Date(Date.now() + minutes * 60_000);
  if (res && res.nextCheckAt > latestAllowed) patch.nextCheckAt = latestAllowed;
  await prisma.resource.update({ where: { id: resourceId }, data: patch });
}

module.exports = { findOrCreateResource, recomputeInterval };
