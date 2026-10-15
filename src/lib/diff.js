'use strict';

const fs = require('node:fs/promises');
const Diff = require('diff');
const { PNG } = require('pngjs');
const pixelmatch = require('pixelmatch');

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const wordCount = (s) => (s.match(/\S+/g) || []).length;

/**
 * Line-level diff plus a word-level change ratio (0..1) used for sensitivity.
 */
function textDiff(prev, next) {
  const lines = Diff.diffLines(prev, next);
  const added = [];
  const removed = [];
  for (const part of lines) {
    const rows = part.value.split('\n').filter(Boolean);
    if (part.added) added.push(...rows);
    else if (part.removed) removed.push(...rows);
  }

  const words = Diff.diffWords(prev, next);
  let changed = 0;
  for (const w of words) if (w.added || w.removed) changed += wordCount(w.value);
  const base = Math.max(wordCount(prev), wordCount(next), 1);
  const changeRatio = Math.min(1, changed / base);

  return { added, removed, changeRatio, changedWords: changed, stats: { added: added.length, removed: removed.length } };
}

/** True when the NUMBERS in the added lines differ from those in the removed lines (price, stock, version...). */
function numericChange({ added, removed }) {
  const nums = (lines) => (lines.join(' ').match(/\d[\d.,]*/g) || []).sort().join('|');
  return nums(added) !== nums(removed);
}

/** Short plain-text digest of a diff, used in alerts when no LLM summary is available. */
function describeDiff({ added, removed }, max = 3) {
  const clip = (s) => (s.length > 120 ? `${s.slice(0, 117)}...` : s);
  const parts = [];
  if (added.length) parts.push(`Added: ${added.slice(0, max).map(clip).join(' | ')}${added.length > max ? ` (+${added.length - max} more)` : ''}`);
  if (removed.length) parts.push(`Removed: ${removed.slice(0, max).map(clip).join(' | ')}${removed.length > max ? ` (+${removed.length - max} more)` : ''}`);
  return parts.join('\n') || 'Content changed';
}

/**
 * Highlighted screenshot diff. Differing pixels are painted red over a faded
 * copy of the NEW screenshot. Images of different heights are padded.
 * @returns {{diffPixels:number, diffRatio:number, png:Buffer}}
 */
async function screenshotDiff(prevPath, nextPath) {
  const [a, b] = await Promise.all([fs.readFile(prevPath), fs.readFile(nextPath)]).then((bufs) =>
    bufs.map((buf) => PNG.sync.read(buf))
  );
  const width = Math.max(a.width, b.width);
  const height = Math.max(a.height, b.height);

  const pad = (img) => {
    if (img.width === width && img.height === height) return img;
    const out = new PNG({ width, height });
    out.data.fill(255);
    PNG.bitblt(img, out, 0, 0, img.width, img.height, 0, 0);
    return out;
  };
  const A = pad(a);
  const B = pad(b);
  const out = new PNG({ width, height });

  const diffPixels = pixelmatch(A.data, B.data, out.data, width, height, {
    threshold: 0.12,
    includeAA: false,
    diffColor: [255, 0, 60],
    alpha: 0.35,
  });
  return { diffPixels, diffRatio: diffPixels / (width * height), png: PNG.sync.write(out) };
}

/** Side-by-side HTML for any two versions. All page text is escaped. */
function renderSideBySideHtml({ title, left, right, highlightUrl }) {
  const rows = [];
  const parts = Diff.diffLines(left.text, right.text);
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    const lines = p.value.replace(/\n$/, '').split('\n');
    const cells = lines.map((l) => esc(l) || '&nbsp;');
    if (p.added) {
      rows.push(...cells.map((c) => `<tr><td class="l empty"></td><td class="r add">${c}</td></tr>`));
    } else if (p.removed) {
      const next = parts[i + 1];
      const pair = next && next.added ? next.value.replace(/\n$/, '').split('\n') : null;
      cells.forEach((c, idx) => {
        const rc = pair && pair[idx] !== undefined ? `<td class="r add">${esc(pair[idx])}</td>` : '<td class="r empty"></td>';
        rows.push(`<tr><td class="l del">${c}</td>${rc}</tr>`);
      });
      if (pair) {
        pair.slice(lines.length).forEach((l) => rows.push(`<tr><td class="l empty"></td><td class="r add">${esc(l)}</td></tr>`));
        i++; // consumed the paired "added" part
      }
    } else {
      rows.push(...cells.map((c) => `<tr><td class="l">${c}</td><td class="r">${c}</td></tr>`));
    }
  }

  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
body{font:14px/1.5 system-ui,sans-serif;margin:0;color:#1a1a1a}
header{padding:12px 20px;border-bottom:1px solid #ddd}
h1{font-size:16px;margin:0 0 4px}
table{width:100%;border-collapse:collapse;table-layout:fixed}
th{position:sticky;top:0;background:#f6f6f6;text-align:left;padding:6px 10px;border-bottom:1px solid #ddd}
td{vertical-align:top;padding:2px 10px;word-wrap:break-word;white-space:pre-wrap;width:50%}
.add{background:#e6ffed}.del{background:#ffeef0}.empty{background:#fafafa}
.shots{display:grid;grid-template-columns:1fr 1fr;gap:12px;padding:12px 20px}
.shots img{max-width:100%;border:1px solid #ddd}
</style></head><body>
<header><h1>${esc(title)}</h1><div>v${left.version} (${esc(left.createdAt)}) &rarr; v${right.version} (${esc(right.createdAt)})</div></header>
<div class="shots">${left.shotUrl ? `<img src="${esc(left.shotUrl)}" alt="v${left.version}">` : ''}${right.shotUrl ? `<img src="${esc(right.shotUrl)}" alt="v${right.version}">` : ''}${highlightUrl ? `<div style="grid-column:1/-1"><strong>Highlighted visual changes (red)</strong><br><img src="${esc(highlightUrl)}" alt="visual diff"></div>` : ''}</div>
<table><thead><tr><th>Version ${left.version}</th><th>Version ${right.version}</th></tr></thead><tbody>${rows.join('')}</tbody></table>
</body></html>`;
}

module.exports = { textDiff, numericChange, describeDiff, screenshotDiff, renderSideBySideHtml };
