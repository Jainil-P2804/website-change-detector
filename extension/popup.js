// Browser extension popup. Talks to:
//   GET  {server}/api/extension/lookup?url=...   -> { tracked, target }
//   POST {server}/api/extension/add              -> { created, target }
// Auth: X-API-Token header (the token shown in the dashboard settings).

const $ = (id) => document.getElementById(id);
let tab;

async function config() {
  const { server, token } = await chrome.storage.sync.get(['server', 'token']);
  return { server: (server || 'http://localhost:3000').replace(/\/+$/, ''), token };
}

async function call(path, init = {}) {
  const { server, token } = await config();
  if (!token) throw new Error('Set your API token under "Connection".');
  const res = await fetch(server + path, {
    ...init,
    headers: { 'content-type': 'application/json', 'x-api-token': token },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

async function init() {
  const { server, token } = await config();
  $('server').value = server;
  $('token').value = token || '';

  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  $('name').value = tab && tab.title ? tab.title.slice(0, 120) : '';

  if (!tab || !/^https?:/.test(tab.url || '')) {
    $('go').disabled = true;
    $('msg').textContent = 'Only http(s) pages can be tracked.';
    return;
  }
  try {
    const r = await call('/api/extension/lookup?url=' + encodeURIComponent(tab.url));
    if (r.tracked) {
      $('go').disabled = true;
      $('msg').textContent = `Already tracking (status: ${r.target.status}).`;
    }
  } catch (e) {
    $('msg').textContent = e.message;
  }
}

$('go').onclick = async () => {
  $('msg').textContent = 'Adding...';
  try {
    const r = await call('/api/extension/add', {
      method: 'POST',
      body: JSON.stringify({ url: tab.url, name: $('name').value || undefined, intervalMinutes: Number($('interval').value) }),
    });
    $('msg').textContent = r.created ? 'Tracking started.' : 'You were already tracking this page.';
    $('go').disabled = true;
  } catch (e) {
    $('msg').textContent = e.message;
  }
};

$('save').onclick = async () => {
  await chrome.storage.sync.set({ server: $('server').value.trim(), token: $('token').value.trim() });
  $('msg').textContent = 'Saved.';
};

init();
