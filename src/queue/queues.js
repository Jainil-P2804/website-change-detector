'use strict';

const { Queue } = require('bullmq');
const IORedis = require('ioredis');
const config = require('../config');

// BullMQ requires maxRetriesPerRequest: null on its connections.
const connection = new IORedis(config.redisUrl, { maxRetriesPerRequest: null });

const CHECKS = 'checks';
const NOTIFY = 'notify';

const checkQueue = new Queue(CHECKS, {
  connection,
  defaultJobOptions: {
    attempts: config.worker.attempts,
    backoff: { type: 'exponential', delay: 30_000 }, // 30s, 60s, ...
    // Both must be removed so the deterministic jobId (check-<resourceId>) can be reused.
    // Outcomes are persisted in Postgres, not in Redis.
    removeOnComplete: true,
    removeOnFail: true,
  },
});

const notifyQueue = new Queue(NOTIFY, {
  connection,
  defaultJobOptions: {
    attempts: 5,
    backoff: { type: 'exponential', delay: 10_000 },
    removeOnComplete: { age: 3600 },
    removeOnFail: { age: 7 * 24 * 3600 },
  },
});

module.exports = { connection, checkQueue, notifyQueue, CHECKS, NOTIFY };
