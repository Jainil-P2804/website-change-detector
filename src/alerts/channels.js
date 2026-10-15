'use strict';

const nodemailer = require('nodemailer');
const config = require('../config');
const { assertPublicUrl } = require('../lib/url');

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

let transport = null;
function mailer() {
  if (!config.smtp.host) return null;
  if (!transport) {
    transport = nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.port === 465,
      auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
    });
  }
  return transport;
}

/**
 * items: [{ page, url, summary, diffUrl, kind }]
 * kind: 'change' | 'down' | 'recovered' | 'volatile'
 */
function render(items, { digest = false } = {}) {
  const subject = digest
    ? `Daily digest: ${items.length} page change${items.length === 1 ? '' : 's'}`
    : items.length === 1
      ? `${items[0].kind === 'change' ? 'Change detected' : 'Page status'}: ${items[0].page}`
      : `${items.length} updates from Website Change Detector`;

  const text = items
    .map((i) => `* ${i.page}\n  ${i.summary}\n  ${i.diffUrl ? `Diff: ${i.diffUrl}` : i.url}`)
    .join('\n\n');

  const html = `<div style="font:14px/1.5 system-ui,sans-serif;max-width:640px">${items
    .map(
      (i) => `<div style="margin:0 0 18px"><strong>${esc(i.page)}</strong><br>${esc(i.summary).replace(/\n/g, '<br>')}<br>${
        i.diffUrl ? `<a href="${esc(i.diffUrl)}">View diff</a>` : `<a href="${esc(i.url)}">${esc(i.url)}</a>`
      }</div>`
    )
    .join('')}</div>`;
  return { subject, text, html };
}

async function sendEmail(to, items, opts) {
  const t = mailer();
  if (!t) throw new Error('SMTP not configured');
  const { subject, text, html } = render(items, opts);
  await t.sendMail({ from: config.smtp.from, to, subject, text, html });
}

async function sendTelegram(token, chatId, items, opts) {
  const { subject, text } = render(items, opts);
  const res = await fetch(`https://api.telegram.org/bot${encodeURIComponent(token)}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    // No parse_mode: page text is untrusted, so we never let it be interpreted as markup.
    body: JSON.stringify({ chat_id: chatId, text: `${subject}\n\n${text}`.slice(0, 4000), disable_web_page_preview: true }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Telegram ${res.status}`);
}

const DISCORD_RE = /^https:\/\/(?:ptb\.|canary\.)?(?:discord|discordapp)\.com\/api\/webhooks\//;

function validateDiscordUrl(url) {
  if (!DISCORD_RE.test(url)) throw new Error('Not a Discord webhook URL');
}

async function sendDiscord(url, items, opts) {
  validateDiscordUrl(url);
  const { subject } = render(items, opts);
  const embeds = items.slice(0, 10).map((i) => ({
    title: String(i.page).slice(0, 250),
    url: i.diffUrl || i.url,
    description: String(i.summary).slice(0, 1800),
  }));
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    // allowed_mentions empty: page text must never be able to @everyone.
    body: JSON.stringify({ content: subject.slice(0, 200), embeds, allowed_mentions: { parse: [] } }),
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Discord ${res.status}`);
}

async function sendWebhook(url, items, { digest = false } = {}) {
  await assertPublicUrl(url); // user-supplied URL: no internal targets
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': 'WebsiteChangeDetector/1.0' },
    body: JSON.stringify({
      event: digest ? 'digest' : 'update',
      items: items.map((i) => ({ kind: i.kind, page: i.page, url: i.url, summary: i.summary, diffUrl: i.diffUrl || null })),
    }),
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Webhook ${res.status}`);
}

/** Channels a user has configured. */
function channelsFor(user, settings) {
  const list = [];
  if (settings.emailEnabled) list.push({ type: 'EMAIL', send: (items, o) => sendEmail(user.email, items, o) });
  if (settings.telegramBotToken && settings.telegramChatId) {
    list.push({ type: 'TELEGRAM', send: (items, o) => sendTelegram(settings.telegramBotToken, settings.telegramChatId, items, o) });
  }
  if (settings.discordWebhookUrl) list.push({ type: 'DISCORD', send: (items, o) => sendDiscord(settings.discordWebhookUrl, items, o) });
  if (settings.genericWebhookUrl) list.push({ type: 'WEBHOOK', send: (items, o) => sendWebhook(settings.genericWebhookUrl, items, o) });
  return list;
}

/**
 * Delivers to every configured channel. Resolves true if at least one channel
 * succeeded (one broken channel must not suppress the others).
 */
async function deliver(user, settings, items, opts = {}) {
  const channels = channelsFor(user, settings);
  if (!channels.length) return { delivered: false, noChannels: true };
  let ok = 0;
  for (const ch of channels) {
    try {
      await ch.send(items, opts);
      ok++;
    } catch (err) {
      console.warn(`[alerts] ${ch.type} delivery to user ${user.id} failed: ${err.message}`);
    }
  }
  return { delivered: ok > 0, noChannels: false };
}

module.exports = { deliver, validateDiscordUrl };
