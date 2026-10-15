'use strict';

const int = (v, d) => (v === undefined || v === '' ? d : parseInt(v, 10));

module.exports = {
  port: int(process.env.PORT, 3000),
  publicBaseUrl: process.env.PUBLIC_BASE_URL || 'http://localhost:3000',
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  jwtSecret: process.env.JWT_SECRET || 'dev-secret-change-me',
  artifactDir: process.env.ARTIFACT_DIR || './data/artifacts',

  worker: {
    concurrency: int(process.env.WORKER_CONCURRENCY, 4),
    scrapeTimeoutMs: int(process.env.SCRAPE_TIMEOUT_MS, 45000),
    attempts: int(process.env.SCRAPE_ATTEMPTS, 3),
    domainMaxConcurrent: int(process.env.DOMAIN_MAX_CONCURRENT, 2),
    domainMinGapMs: int(process.env.DOMAIN_MIN_GAP_MS, 3000),
  },

  volatile: {
    maxChanges: int(process.env.VOLATILE_MAX_CHANGES, 6),
    windowMin: int(process.env.VOLATILE_WINDOW_MIN, 60),
  },

  interval: { minMinutes: 15, maxMinutes: 1440 },

  smtp: {
    host: process.env.SMTP_HOST,
    port: int(process.env.SMTP_PORT, 587),
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
    from: process.env.SMTP_FROM || 'Website Change Detector <alerts@localhost>',
  },

  llm: {
    apiKey: process.env.LLM_API_KEY,
    model: process.env.LLM_MODEL || 'claude-haiku-5-5',
  },

  // What counts as "meaningful" per sensitivity level (applied per subscriber at alert time).
  //   minWords / minRatio : changed words (absolute) and as a fraction of the page
  //   numeric             : a changed number (price, stock, version) always counts
  // LOW also uses the aggressive noise patterns (counters, "N left", copyright years).
  sensitivity: {
    HIGH: { minWords: 1, minRatio: 0, numeric: true },
    MEDIUM: { minWords: 3, minRatio: 0, numeric: true },
    LOW: { minWords: 10, minRatio: 0.02, numeric: false },
  },
};
