'use strict';

/**
 * Scheduler: every few seconds, find Resources whose nextCheckAt has passed
 * and enqueue ONE BullMQ job per Resource (not per user).
 *
 * Safety properties
 *   * FOR UPDATE SKIP LOCKED  -> several scheduler replicas never double-claim
 *   * "lease": claiming pushes nextCheckAt 10 minutes out, so a job lost to a
 *     crash is simply retried after the lease expires; the worker overwrites
 *     nextCheckAt with the precise next time when the check finishes
 *   * deterministic jobId     -> BullMQ ignores a duplicate while one is queued
 *   * random start jitter     -> avoids a thundering herd at :00 / :15 / :30
 */

const prisma = require('../db');
const { checkQueue, notifyQueue } = require('./queues');

const TICK_MS = 15_000;
const BATCH = 200;
const LEASE_MINUTES = 10;

async function claimDue() {
  return prisma.$queryRaw`
    UPDATE "Resource" AS r
       SET "nextCheckAt" = NOW() + make_interval(mins => ${LEASE_MINUTES}::int)
     WHERE r.id IN (
       SELECT id FROM "Resource"
        WHERE "nextCheckAt" <= NOW()
          AND EXISTS (SELECT 1 FROM "TrackedUrl" t WHERE t."resourceId" = "Resource".id AND t."paused" = false)
        ORDER BY "nextCheckAt" ASC
        LIMIT ${BATCH}
        FOR UPDATE SKIP LOCKED
     )
    RETURNING r.id, r."domain"`;
}

async function tick() {
  const due = await claimDue();
  if (!due.length) return;
  await checkQueue.addBulk(
    due.map((r) => ({
      name: 'check',
      data: { resourceId: r.id, domain: r.domain },
      opts: { jobId: `check-${r.id}`, delay: Math.floor(Math.random() * 30_000) },
    }))
  );
  console.log(`[scheduler] enqueued ${due.length} checks`);
}

async function main() {
  // Hourly digest trigger; the notify worker decides which users are due right now.
  await notifyQueue.upsertJobScheduler('digest-hourly', { pattern: '0 * * * *' }, { name: 'digest', data: {} });

  console.log('[scheduler] started');
  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);

  while (!stopping) {
    try {
      await tick();
    } catch (err) {
      console.error('[scheduler] tick failed:', err.message);
    }
    await new Promise((r) => setTimeout(r, TICK_MS));
  }
  process.exit(0);
}

if (require.main === module) main();

module.exports = { tick };
