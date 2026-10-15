'use strict';

const prisma = require('../db');
const { findOrCreateResource, recomputeInterval } = require('../lib/resources');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * Creates a subscription. If another user already tracks the same normalized
 * URL + selector profile, this simply attaches to the existing Resource: no new
 * fetch work is created (Edge Case #2).
 */
async function createTarget(userId, input) {
  let resource;
  try {
    resource = await findOrCreateResource(input);
  } catch (err) {
    throw new HttpError(400, err.message);
  }

  try {
    const target = await prisma.trackedUrl.create({
      data: {
        userId,
        resourceId: resource.id,
        name: input.name,
        url: input.url,
        intervalMinutes: input.intervalMinutes,
        sensitivity: input.sensitivity,
        watchSelectors: input.watchSelectors,
        ignoreSelectors: input.ignoreSelectors,
        keywordsAdded: input.keywordsAdded,
        keywordsRemoved: input.keywordsRemoved,
        numberRules: input.numberRules && input.numberRules.length ? input.numberRules : undefined,
      },
    });
    await recomputeInterval(resource.id);
    return { target, created: true };
  } catch (err) {
    if (err.code === 'P2002') {
      const existing = await prisma.trackedUrl.findFirst({ where: { userId, resourceId: resource.id } });
      return { target: existing, created: false };
    }
    throw err;
  }
}

async function updateTarget(userId, id, patch) {
  const current = await prisma.trackedUrl.findFirst({ where: { id, userId } });
  if (!current) throw new HttpError(404, 'Not found');

  const merged = {
    url: patch.url ?? current.url,
    watchSelectors: patch.watchSelectors ?? current.watchSelectors,
    ignoreSelectors: patch.ignoreSelectors ?? current.ignoreSelectors,
  };

  // Changing the URL or the regions moves the subscription to a different shared Resource.
  let resourceId = current.resourceId;
  if (patch.url !== undefined || patch.watchSelectors !== undefined || patch.ignoreSelectors !== undefined) {
    try {
      resourceId = (await findOrCreateResource(merged)).id;
    } catch (err) {
      throw new HttpError(400, err.message);
    }
  }

  let updated;
  try {
    updated = await prisma.trackedUrl.update({
      where: { id },
      data: { ...patch, resourceId, numberRules: patch.numberRules ?? undefined },
    });
  } catch (err) {
    if (err.code === 'P2002') throw new HttpError(409, 'You already track this page with the same regions');
    throw err;
  }
  await recomputeInterval(resourceId);
  if (resourceId !== current.resourceId) await recomputeInterval(current.resourceId);
  return updated;
}

async function deleteTarget(userId, id) {
  const current = await prisma.trackedUrl.findFirst({ where: { id, userId } });
  if (!current) throw new HttpError(404, 'Not found');
  await prisma.trackedUrl.delete({ where: { id } });
  await recomputeInterval(current.resourceId);
}

module.exports = { HttpError, createTarget, updateTarget, deleteTarget };
