'use strict';

/**
 * Decides whether a fetch produced a REAL page or an operational problem.
 *
 * Design rule (Edge Case #1): outages, 404s and CAPTCHA walls are NEVER
 * "changes". They set Resource.status, they never create a Snapshot, and the
 * last good snapshot stays the baseline. When the site recovers we compare
 * against that baseline, so a 3-hour outage does not generate a
 * "page changed to 'Service Unavailable' and back" pair of false alerts.
 *
 * @param {{httpStatus:number|null, title:string, text:string, hasCaptchaFrame:boolean, navError?:string}} sig
 * @returns {{state:'OK'|'ERROR'|'NOT_FOUND'|'BLOCKED', detail:string|null, retryable:boolean}}
 */
const BLOCK_TEXT = [
  /verify (?:that )?you are (?:a )?human/i,
  /are you a robot/i,
  /unusual traffic from your computer/i,
  /checking your browser before accessing/i,
  /enable javascript and cookies to continue/i,
  /access (?:to this page )?(?:has been )?denied/i,
  /attention required!?\s*\|\s*cloudflare/i,
  /just a moment\.\.\./i,
  /press (?:&|and) hold/i,
  /request blocked/i,
  /pardon our interruption/i,
  /\b(?:captcha|recaptcha|hcaptcha|cf-turnstile)\b/i,
];

const SOFT_404 = [/\bpage not found\b/i, /\b404\b.{0,40}(?:not found|error)/i, /\bno longer available\b/i];

function classifyFetch({ httpStatus, title = '', text = '', hasCaptchaFrame = false, navError }) {
  if (navError) {
    const timeout = /timeout/i.test(navError);
    return { state: 'ERROR', detail: timeout ? 'Timed out loading page' : navError.slice(0, 200), retryable: true };
  }

  // Bot walls frequently return 200, so check the content as well as the status.
  const head = `${title}\n${text.slice(0, 2000)}`;
  const looksBlocked = hasCaptchaFrame || (text.length < 3000 && BLOCK_TEXT.some((re) => re.test(head)));

  if (httpStatus === 429) return { state: 'BLOCKED', detail: 'Rate limited by site (429)', retryable: true };
  if (httpStatus === 403 || httpStatus === 401 || looksBlocked) {
    return { state: 'BLOCKED', detail: looksBlocked ? 'CAPTCHA / bot challenge detected' : `HTTP ${httpStatus}`, retryable: false };
  }
  if (httpStatus === 404 || httpStatus === 410) {
    return { state: 'NOT_FOUND', detail: `HTTP ${httpStatus}`, retryable: false };
  }
  if (httpStatus >= 500 || httpStatus === 408) {
    return { state: 'ERROR', detail: `HTTP ${httpStatus}`, retryable: true };
  }
  if (httpStatus >= 400) return { state: 'ERROR', detail: `HTTP ${httpStatus}`, retryable: false };

  // Soft 404: 200 status but obviously an error page.
  if (text.length < 1500 && SOFT_404.some((re) => re.test(head))) {
    return { state: 'NOT_FOUND', detail: 'Soft 404 (error page served with HTTP 200)', retryable: false };
  }
  if (text.trim().length === 0) {
    return { state: 'ERROR', detail: 'Page rendered empty', retryable: true };
  }
  return { state: 'OK', detail: null, retryable: false };
}

module.exports = { classifyFetch };
