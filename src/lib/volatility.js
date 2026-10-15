'use strict';

/**
 * Alert-fatigue defence (Edge Case #3) for pages that differ on EVERY load
 * (rotating recommendations, "trending now" lists, live tickers, A/B tests...).
 *
 * Three cooperating layers:
 *   1. Noise filter (lib/noise-filter.js) removes the obvious stuff.
 *   2. Volatility detection: if a resource produces more than N snapshots in
 *      a time window it is flagged `volatile`.
 *   3. While volatile, we learn the "shape" of lines that keep churning
 *      (digits -> #, long tokens -> *) and exclude lines with those shapes
 *      from the hash and from the diff. A real edit to stable content still
 *      changes the hash; churn does not. Instant alerts are muted meanwhile
 *      (see alerts/dispatcher.js) and a single "this page is noisy" notice is
 *      sent instead of an endless stream.
 *
 * Trade-off: if a legitimately important line also churns constantly, it is
 * masked while the page is volatile. Use the visual picker's "watch" regions
 * (or number tracking, which reads the DOM directly) to target it precisely.
 */

function shapeOf(line) {
  return line
    .toLowerCase()
    .replace(/\d+/g, '#')
    .replace(/[a-z0-9_-]{12,}/g, '*')
    .slice(0, 80);
}

/** Shapes that appear in the added/removed lines of at least `minHits` recent diffs. */
function buildChurnMask(diffs, minHits = 3) {
  const counts = new Map();
  for (const d of diffs) {
    const seen = new Set([...(d.added || []), ...(d.removed || [])].map(shapeOf));
    for (const s of seen) counts.set(s, (counts.get(s) || 0) + 1);
  }
  const mask = new Set();
  for (const [s, n] of counts) if (n >= minHits) mask.add(s);
  return mask;
}

function applyMask(text, mask) {
  if (!mask || mask.size === 0) return text;
  return text
    .split('\n')
    .filter((l) => !mask.has(shapeOf(l)))
    .join('\n');
}

/**
 * @param {Date[]} log previous change timestamps
 * @param {boolean} changedNow whether this check created a snapshot
 * @returns {{log: Date[], volatile: boolean}}
 */
function assessVolatility(log, changedNow, wasVolatile, { windowMin, maxChanges }, now = new Date()) {
  const cutoff = now.getTime() - windowMin * 60_000;
  const next = (log || []).filter((d) => new Date(d).getTime() >= cutoff);
  if (changedNow) next.push(now);

  let volatile = wasVolatile;
  if (next.length > maxChanges) volatile = true;
  else if (wasVolatile && next.length <= 1) volatile = false; // calmed down
  return { log: next, volatile };
}

module.exports = { shapeOf, buildChurnMask, applyMask, assessVolatility };
