'use strict';

const dns = require('node:dns').promises;
const net = require('node:net');
const crypto = require('node:crypto');

// Query params that never change page content.
const TRACKING_PARAMS = /^(utm_.+|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|igshid|ref_src|_ga|_gl|yclid)$/i;

/**
 * Canonical form used as the de-duplication key. Two users who paste
 * "HTTPS://Example.com/a/?utm_source=x#top" and "https://example.com/a"
 * end up on the same Resource and share one fetch.
 */
function normalizeUrl(input) {
  const u = new URL(input.trim());
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Only http(s) URLs are supported');
  u.hash = '';
  u.hostname = u.hostname.toLowerCase();
  if ((u.protocol === 'https:' && u.port === '443') || (u.protocol === 'http:' && u.port === '80')) u.port = '';

  const params = [...u.searchParams.entries()]
    .filter(([k]) => !TRACKING_PARAMS.test(k))
    .sort(([a], [b]) => a.localeCompare(b));
  u.search = '';
  for (const [k, v] of params) u.searchParams.append(k, v);

  if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/+$/, '');
  return u.toString();
}

function domainOf(url) {
  return new URL(url).hostname.toLowerCase();
}

/** Stable hash of a selector profile, so identical configs share a Resource. */
function profileHash(watch = [], ignore = []) {
  const norm = (a) => [...new Set(a.map((s) => s.trim()).filter(Boolean))].sort();
  const w = norm(watch);
  const i = norm(ignore);
  if (!w.length && !i.length) return '';
  return crypto.createHash('sha256').update(JSON.stringify({ w, i })).digest('hex').slice(0, 24);
}

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 10 || a === 127 || a === 0 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80') || v.startsWith('::ffff:');
  }
  return true;
}

/**
 * SSRF guard. We only monitor PUBLIC pages, and a headless browser that can
 * be pointed at http://169.254.169.254/ or http://redis:6379 is dangerous.
 * Called when a target is added AND again before every fetch (DNS can change).
 * The worker additionally blocks private ranges at the browser-request level
 * (see scraper.js `page.route`) so redirects cannot bypass this.
 */
async function assertPublicUrl(url) {
  const { hostname } = new URL(url);
  if (hostname === 'localhost' || hostname.endsWith('.local') || hostname.endsWith('.internal')) {
    throw new Error('Private hosts are not allowed');
  }
  if (net.isIP(hostname)) {
    if (isPrivateIp(hostname)) throw new Error('Private IP addresses are not allowed');
    return;
  }
  const addrs = await dns.lookup(hostname, { all: true });
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) {
    throw new Error('Host resolves to a private address');
  }
}

module.exports = { normalizeUrl, domainOf, profileHash, assertPublicUrl, isPrivateIp };
