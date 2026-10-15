'use strict';

const crypto = require('node:crypto');
const config = require('../config');

/**
 * Alerts contain a direct link to the diff. The link is signed per
 * (subscription, snapshot) so it opens without logging in, but cannot be
 * guessed or reused to read another user's pages.
 */
const sig = (trackedUrlId, snapshotId) =>
  crypto.createHmac('sha256', config.jwtSecret).update(`${trackedUrlId}:${snapshotId}`).digest('hex').slice(0, 32);

function diffLink(trackedUrlId, snapshotId) {
  return `${config.publicBaseUrl}/diff/${snapshotId}?u=${trackedUrlId}&sig=${sig(trackedUrlId, snapshotId)}`;
}

function verifyDiffLink(trackedUrlId, snapshotId, given) {
  const expected = Buffer.from(sig(trackedUrlId, snapshotId));
  const actual = Buffer.from(String(given || ''));
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

/** Signed URL for a stored image (kind: 'shot' = screenshot, 'diff' = highlighted diff). */
function shotLink(trackedUrlId, snapshotId, kind = 'shot') {
  return `${config.publicBaseUrl}/shots/${snapshotId}?u=${trackedUrlId}&sig=${sig(trackedUrlId, snapshotId)}&kind=${kind}`;
}

/** Same idea for per-page RSS feeds: the feed URL carries an unguessable token. */
function feedToken(trackedUrlId) {
  return crypto.createHmac('sha256', config.jwtSecret).update(`feed:${trackedUrlId}`).digest('hex').slice(0, 32);
}

module.exports = { diffLink, shotLink, verifyDiffLink, feedToken };
