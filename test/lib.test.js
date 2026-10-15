'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { cleanText } = require('../src/lib/noise-filter');
const { parseNumber } = require('../src/lib/numbers');
const { keywordChanges } = require('../src/lib/keywords');
const { normalizeUrl, profileHash, isPrivateIp } = require('../src/lib/url');
const { classifyFetch } = require('../src/lib/classify');
const { buildChurnMask, applyMask, assessVolatility } = require('../src/lib/volatility');
const { textDiff, numericChange } = require('../src/lib/diff');

test('noise filter: identical content with different timestamps/counters/tokens normalizes equal', () => {
  const a = 'Welcome\nUpdated: 2025-01-03 10:15:01 UTC\n1,234 views\nsession 9f8a7b6c5d4e3f2a1b0c9d8e\nPrice $99';
  const b = 'Welcome\nUpdated: 2025-01-03 10:16:44 UTC\n1,260 views\nsession 1a2b3c4d5e6f7a8b9c0d1e2f\nPrice $99';
  assert.equal(cleanText(a), cleanText(b));
  assert.match(cleanText(a), /Price \$99/);
});

test('noise filter: real content changes survive', () => {
  assert.notEqual(cleanText('Price $99\n5 minutes ago'), cleanText('Price $79\n9 minutes ago'));
});

test('noise filter: aggressive mode masks counters like "12 comments"', () => {
  assert.notEqual(cleanText('Great post\n12 comments'), cleanText('Great post\n15 comments'));
  assert.equal(cleanText('Great post\n12 comments', { aggressive: true }), cleanText('Great post\n15 comments', { aggressive: true }));
});

test('parseNumber handles US/EU/Indian formats and suffixes', () => {
  assert.equal(parseNumber('$1,299.00'), 1299);
  assert.equal(parseNumber('1.299,50 €'), 1299.5);
  assert.equal(parseNumber('₹ 74,999'), 74999);
  assert.equal(parseNumber('12,5'), 12.5);
  assert.equal(parseNumber('4.5k'), 4500);
  assert.equal(parseNumber('Price: 42 USD', 'Price:\\s*(\\d+)'), 42);
  assert.equal(parseNumber('no digits here'), null);
});

test('keyword alerts fire only on appearance / disappearance, whole words only', () => {
  const r = keywordChanges('Big wholesale event', 'Big sale event', { added: ['sale'], removed: ['wholesale'] });
  assert.deepEqual(r.appeared, ['sale']);
  assert.deepEqual(r.disappeared, ['wholesale']);
  const none = keywordChanges('on sale now', 'on sale today', { added: ['sale'], removed: [] });
  assert.deepEqual(none.appeared, []);
});

test('normalizeUrl collapses tracking params, fragments, case and trailing slash', () => {
  const a = normalizeUrl('HTTPS://Example.com/a/?utm_source=x&b=2&a=1#top');
  const b = normalizeUrl('https://example.com/a?a=1&b=2');
  assert.equal(a, b);
});

test('profileHash is order independent and empty for the whole page', () => {
  assert.equal(profileHash([], []), '');
  assert.equal(profileHash(['.a', '.b'], []), profileHash(['.b', '.a'], []));
  assert.notEqual(profileHash(['.a'], []), profileHash([], ['.a']));
});

test('private IP detection', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.0.1', '172.16.5.5', '169.254.169.254', '::1']) assert.ok(isPrivateIp(ip), ip);
  assert.ok(!isPrivateIp('93.184.216.34'));
});

test('classification: outages, 404 and CAPTCHA are statuses, never content', () => {
  assert.equal(classifyFetch({ httpStatus: 503, title: '', text: 'x' }).state, 'ERROR');
  assert.equal(classifyFetch({ httpStatus: 404, title: '', text: 'x' }).state, 'NOT_FOUND');
  assert.equal(classifyFetch({ httpStatus: 200, title: 'Just a moment...', text: 'Checking your browser before accessing' }).state, 'BLOCKED');
  assert.equal(classifyFetch({ httpStatus: 200, title: 'Shop', text: 'Hello world '.repeat(50), hasCaptchaFrame: true }).state, 'BLOCKED');
  assert.equal(classifyFetch({ httpStatus: 200, title: 'Shop', text: 'Real page content '.repeat(20) }).state, 'OK');
  assert.equal(classifyFetch({ navError: 'page.goto: Timeout 45000ms exceeded' }).state, 'ERROR');
});

test('volatility: churn mask hides lines that change on every load but keeps real edits', () => {
  const diffs = [1, 2, 3, 4].map((n) => ({ added: [`Trending now: item ${n}00`], removed: [`Trending now: item ${n - 1}00`] }));
  const mask = buildChurnMask(diffs);
  const before = applyMask('Headline\nTrending now: item 500', mask);
  const after = applyMask('Headline\nTrending now: item 900', mask);
  assert.equal(before, after);
  assert.notEqual(applyMask('Headline v1\nTrending now: item 1', mask), applyMask('Headline v2\nTrending now: item 1', mask));
});

test('volatility: flagged after too many changes in the window, cleared when calm', () => {
  const cfg = { windowMin: 60, maxChanges: 3 };
  const now = new Date();
  const recent = [1, 2, 3].map((m) => new Date(now.getTime() - m * 60_000));
  const hot = assessVolatility(recent, true, false, cfg, now);
  assert.equal(hot.volatile, true);
  const calm = assessVolatility([new Date(now.getTime() - 3 * 3600_000)], false, true, cfg, now);
  assert.equal(calm.volatile, false);
});

test('diff: changed numbers are detected even in a long page', () => {
  const filler = Array.from({ length: 200 }, (_, i) => `line number ${i} with some filler words`).join('\n');
  const d = textDiff(`${filler}\nPrice $99`, `${filler}\nPrice $79`);
  assert.ok(numericChange(d));
  assert.ok(d.changeRatio < 0.01);
});
