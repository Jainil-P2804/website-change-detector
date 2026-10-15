'use strict';

/**
 * Noise filtering happens in two layers:
 *
 *  1. DOM layer (runs inside the page, see NOISE_SELECTORS + scraper.js):
 *     removes ads, banners, carousels, cookie bars, scripts, etc. BEFORE text
 *     is extracted, so they never reach the hash.
 *
 *  2. Text layer (cleanText below): masks values that change on every load
 *     even when the visible "content" did not: timestamps, relative times,
 *     view counters, session tokens, UUIDs, nonces.
 *
 * The result is the "normalized text" that gets hashed and diffed. The raw
 * text is hashed separately (rawHash) purely so we can measure how much noise
 * a page produces.
 */

// Elements dropped in the browser before extraction.
const NOISE_SELECTORS = [
  'script', 'style', 'noscript', 'template', 'iframe', 'canvas', 'svg',
  '[aria-hidden="true"]',
  // advertising
  'ins.adsbygoogle', '[id^="google_ads"]', '[id*="-ad-"]', '[id^="ad-"]', '[id$="-ad"]',
  '[class~="ad"]', '[class~="ads"]', '[class*="advert"]', '[class*="sponsor"]',
  '[data-ad]', '[data-ad-slot]', '[data-google-query-id]',
  // rotating content
  '[class*="carousel"]', '[class*="slider"]', '[class*="swiper"]', '[class*="slick-"]',
  '[class*="banner"]', '[class*="marquee"]', '[class*="ticker"]',
  // consent / chat widgets / live counters
  '[id*="cookie"]', '[class*="cookie"]', '[class*="consent"]', '[id*="onetrust"]',
  '[class*="chat-widget"]', '[class*="intercom"]', '[class*="livechat"]',
  '[class*="view-count"]', '[class*="visitor"]', '[class*="countdown"]',
  // CSRF / nonce carriers
  'input[type="hidden"]', 'meta',
];

const MONTHS = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';

// Always applied (all sensitivities): patterns that are almost never "content".
const BASE_PATTERNS = [
  // ISO 8601 / RFC 3339 timestamps
  /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?\b/g,
  // 12:34, 12:34:56, 12:34 PM (with optional timezone abbreviation)
  /\b\d{1,2}:\d{2}(?::\d{2})?\s?(?:[AaPp]\.?[Mm]\.?)?(?:\s?(?:UTC|GMT|[ECMP][SD]T|IST))?\b/g,
  // "5 minutes ago", "an hour ago", "just now", "yesterday", "moments ago"
  /\b(?:just now|moments? ago|yesterday|today|(?:\d+|an?|one|few)\s+(?:seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?|months?|years?)\s+ago)\b/gi,
  // "Updated: ...", "Last updated ...", "Generated at ..." - drop the whole remainder of the line
  /\b(?:last\s+)?(?:updated|modified|refreshed|generated|rendered|retrieved|as of|served)\b[^\n]{0,60}/gi,
  // "Feb 3, 2025", "3 February 2025", "03/02/2025"
  new RegExp(`\\b${MONTHS}\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+\\d{4})?\\b`, 'gi'),
  new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?\\s+${MONTHS}\\.?(?:,?\\s+\\d{4})?\\b`, 'gi'),
  /\b\d{1,4}[/.-]\d{1,2}[/.-]\d{1,4}\b/g,
  // view / visitor counters: "1,234 views", "Views: 5.2k", "12 people are viewing"
  /\b[\d.,]+\s?[kKmM]?\s+(?:views?|visits?|visitors?|hits|impressions|watching|viewing|reads|plays)\b/gi,
  /\b(?:views?|visits?|visitors?|hits|impressions|reads|plays)\s*[:\-]?\s*[\d.,]+\s?[kKmM]?\b/gi,
  /\b\d+\s+(?:people|users|others|shoppers|customers)\s+(?:are\s+)?(?:viewing|watching|online|browsing)\b/gi,
  // UUIDs
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi,
  // long hex / base64 / base64url tokens: session ids, CSRF tokens, cache busters (>= 20 chars, mixed)
  /\b(?=[A-Za-z0-9_\-+/=]*\d)(?=[A-Za-z0-9_\-+/=]*[A-Za-z])[A-Za-z0-9_\-+/=]{20,}\b/g,
  /\b[0-9a-f]{16,}\b/gi,
  // unix epoch timestamps (10 or 13 digits)
  /\b1[0-9]{9}(?:[0-9]{3})?\b/g,
  // cache-buster query strings that leak into visible link text
  /[?&](?:v|ver|_|ts|t|cb|nocache|sid|session(?:id)?|token)=[^\s&]+/gi,
];

// Extra patterns for sensitivity = LOW ("only tell me about big changes").
const AGGRESSIVE_PATTERNS = [
  /\b[\d.,]+\s?[kKmM]?\s+(?:likes?|comments?|shares?|followers?|subscribers?|replies|votes?|points?|reactions?|ratings?|reviews?|stars?|downloads?|sold|left|remaining|in stock|online|members?)\b/gi,
  /\b(?:only\s+)?\d+\s+(?:items?\s+)?(?:left|remaining|available)\b/gi,
  /\b(?:copyright|©)\s*(?:\(c\)\s*)?\d{4}(?:\s*[-–]\s*\d{4})?\b/gi,
];

/**
 * @param {string} text raw innerText extracted from the page
 * @param {{aggressive?: boolean}} opts
 * @returns {string} normalized text, one logical line per row
 */
function cleanText(text, { aggressive = false } = {}) {
  let out = text.normalize('NFKC').replace(/ /g, ' ');
  const patterns = aggressive ? [...BASE_PATTERNS, ...AGGRESSIVE_PATTERNS] : BASE_PATTERNS;
  for (const re of patterns) out = out.replace(re, ' ');

  return out
    .split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').replace(/^[\s|·•\-–—:,;]+|[\s|·•\-–—:,;]+$/g, '').trim())
    .filter((l) => l.length > 0)
    .join('\n');
}

/**
 * Sensitivity also decides the minimum fraction of changed words that counts
 * as "meaningful" (see config.sensitivityThreshold and alerts/dispatcher.js).
 */
function isAggressive(sensitivity) {
  return sensitivity === 'LOW';
}

module.exports = { NOISE_SELECTORS, cleanText, isAggressive };
