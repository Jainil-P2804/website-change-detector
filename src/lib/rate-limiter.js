'use strict';

const crypto = require('node:crypto');
const IORedis = require('ioredis');
const config = require('../config');

/**
 * Per-domain politeness limiter shared by ALL worker processes through Redis.
 *
 *   * max N concurrent fetches per domain   (sorted set of live "slots")
 *   * minimum gap between fetch STARTS      (next-allowed timestamp)
 *   * penalize(domain, ms) pushes the next-allowed time out, used on 429 /
 *     Retry-After so every worker backs off together.
 *
 * Slots carry a TTL, so a crashed worker can never leak a slot permanently.
 * Redis TIME is used inside the script, so worker clock skew is irrelevant.
 */
const ACQUIRE_LUA = `
local t = redis.call('TIME')
local now = t[1] * 1000 + math.floor(t[2] / 1000)
local max = tonumber(ARGV[1])
local gap = tonumber(ARGV[2])
local ttl = tonumber(ARGV[3])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
local active = redis.call('ZCARD', KEYS[1])
local nextAt = tonumber(redis.call('GET', KEYS[2]) or '0')
if active >= max then return 500 end
if nextAt > now then return nextAt - now end
redis.call('ZADD', KEYS[1], now + ttl, ARGV[4])
redis.call('SET', KEYS[2], now + gap, 'PX', ttl + gap)
return 0
`;

const PENALIZE_LUA = `
local t = redis.call('TIME')
local now = t[1] * 1000 + math.floor(t[2] / 1000)
local target = now + tonumber(ARGV[1])
local cur = tonumber(redis.call('GET', KEYS[1]) or '0')
if target > cur then redis.call('SET', KEYS[1], target, 'PX', tonumber(ARGV[1]) + 60000) end
return 1
`;

class RateLimitedError extends Error {
  constructor(waitMs) {
    super(`Domain busy, retry in ${waitMs}ms`);
    this.name = 'RateLimitedError';
    this.waitMs = waitMs;
  }
}

class DomainLimiter {
  constructor(redis = new IORedis(config.redisUrl, { maxRetriesPerRequest: null })) {
    this.redis = redis;
  }

  _keys(domain) {
    return [`wcd:dom:${domain}:slots`, `wcd:dom:${domain}:next`];
  }

  /**
   * Waits up to `maxWaitMs` for a slot. If none opens, throws RateLimitedError
   * so the job can be rescheduled instead of blocking a worker thread.
   * @returns {Promise<() => Promise<void>>} release function
   */
  async acquire(domain, { maxWaitMs = 20000, ttlMs = config.worker.scrapeTimeoutMs + 15000 } = {}) {
    const token = crypto.randomUUID();
    const [slots, next] = this._keys(domain);
    const deadline = Date.now() + maxWaitMs;

    for (;;) {
      const wait = await this.redis.eval(
        ACQUIRE_LUA, 2, slots, next,
        config.worker.domainMaxConcurrent, config.worker.domainMinGapMs, ttlMs, token
      );
      if (wait === 0) return () => this.redis.zrem(slots, token).then(() => undefined);

      // Add jitter so waiting workers do not stampede the instant a slot frees.
      const sleep = Math.min(wait, 2000) + Math.floor(Math.random() * 250);
      if (Date.now() + sleep > deadline) throw new RateLimitedError(Math.max(wait, 1000));
      await new Promise((r) => setTimeout(r, sleep));
    }
  }

  penalize(domain, ms) {
    return this.redis.eval(PENALIZE_LUA, 1, this._keys(domain)[1], ms);
  }
}

module.exports = { DomainLimiter, RateLimitedError };
