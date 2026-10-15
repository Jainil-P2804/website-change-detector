'use strict';

const { Worker, DelayedError } = require('bullmq');
const prisma = require('../db');
const config = require('../config');
const { connection, notifyQueue, CHECKS, NOTIFY } = require('../queue/queues');
const { DomainLimiter, RateLimitedError } = require('../lib/rate-limiter');
const { checkResource, closeBrowser, nextDelayMs } = require('./scraper');
const { handleNotifyJob } = require('../alerts/dispatcher');

const limiter = new DomainLimiter();
const HARD_TIMEOUT_MS = config.worker.scrapeTimeoutMs * 2 + 30_000;

function withTimeout(promise, ms, label) {
  let t;
  const timeout = new Promise((_, rej) => {
    t = setTimeout(() => rej(new Error(`${label} exceeded ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

/** Queue notification jobs that follow from a check outcome. */
async function dispatchOutcome(resourceId, outcome) {
  if (outcome.snapshotId && outcome.changed) {
    await notifyQueue.add('snapshot', { snapshotId: outcome.snapshotId, previousSnapshotId: outcome.previousSnapshotId },
      { jobId: `snap-${outcome.snapshotId}` });
  }
  if (outcome.becameVolatile) {
    await notifyQueue.add('volatile', { resourceId }, { jobId: `volatile-${resourceId}-${Date.now()}` });
  }
  if (outcome.statusEvent) {
    await notifyQueue.add('status', { resourceId, ...outcome.statusEvent }, { jobId: `status-${resourceId}-${Date.now()}` });
  }
}

const checkWorker = new Worker(
  CHECKS,
  async (job, token) => {
    const attempts = job.opts.attempts || 1;
    const isLastAttempt = job.attemptsMade + 1 >= attempts;
    try {
      const outcome = await withTimeout(
        checkResource(job.data.resourceId, { limiter, isLastAttempt }),
        HARD_TIMEOUT_MS,
        'check job'
      );
      await dispatchOutcome(job.data.resourceId, outcome);
      return outcome;
    } catch (err) {
      if (err instanceof RateLimitedError) {
        // Domain is saturated: park the job instead of occupying a worker slot.
        await job.moveToDelayed(Date.now() + err.waitMs + Math.floor(Math.random() * 5000), token);
        throw new DelayedError();
      }
      throw err; // BullMQ applies the exponential-backoff retry policy
    }
  },
  {
    connection,
    concurrency: config.worker.concurrency,
    lockDuration: HARD_TIMEOUT_MS + 30_000,
  }
);

// Retries exhausted by exceptions that never reached the classifier (browser crash, DB error...).
checkWorker.on('failed', async (job, err) => {
  if (!job || job.attemptsMade < (job.opts.attempts || 1)) return;
  console.error(`[worker] check ${job.data.resourceId} failed permanently: ${err.message}`);
  try {
    const r = await prisma.resource.findUnique({ where: { id: job.data.resourceId } });
    if (!r) return;
    const errors = r.consecutiveErrors + 1;
    await prisma.resource.update({
      where: { id: r.id },
      data: {
        status: 'ERROR',
        statusDetail: String(err.message).slice(0, 200),
        consecutiveErrors: errors,
        lastCheckedAt: new Date(),
        nextCheckAt: new Date(Date.now() + nextDelayMs(r.intervalMinutes, errors)),
      },
    });
    if (errors === 2) {
      await notifyQueue.add('status', { resourceId: r.id, type: 'DOWN', state: 'ERROR', detail: String(err.message).slice(0, 200) },
        { jobId: `status-${r.id}-${Date.now()}` });
    }
  } catch (e) {
    console.error('[worker] could not record failure:', e.message);
  }
});

const notifyWorker = new Worker(NOTIFY, (job) => handleNotifyJob(job), { connection, concurrency: 5 });
notifyWorker.on('failed', (job, err) => console.error(`[notify] ${job && job.name} failed: ${err.message}`));

console.log(`[worker] up, concurrency=${config.worker.concurrency}`);

async function shutdown() {
  console.log('[worker] shutting down...');
  await Promise.all([checkWorker.close(), notifyWorker.close()]);
  await closeBrowser();
  await prisma.$disconnect();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
