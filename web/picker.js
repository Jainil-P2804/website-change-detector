/*
 * Region picker - runs INSIDE the sandboxed preview iframe.
 *
 * Parent -> frame:  { type: 'mode', mode: 'watch' | 'ignore' }
 * Frame -> parent:  { type: 'wcd-selected', mode, selector, preview, matches }
 *
 * Hover highlights an element, click selects it and reports a CSS selector
 * that is as short and as stable as possible.
 */
(function () {
  var mode = 'watch';
  var hovered = null;
  var COLORS = { watch: '#1a9850', ignore: '#d73027' };

  var box = document.createElement('div');
  box.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483647;border:2px solid #1a9850;background:rgba(26,152,80,.15);display:none;transition:all .05s';
  document.documentElement.appendChild(box);

  var chosen = [];

  function escapeIdent(s) {
    return window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
  }

  function unique(sel, el) {
    try {
      var found = document.querySelectorAll(sel);
      return found.length === 1 && found[0] === el;
    } catch (e) {
      return false;
    }
  }

  // Class names that look auto-generated (css-1a2b3c, sc-xyz, hashed modules) make brittle selectors.
  function stableClass(c) {
    return c.length < 40 && !/^(css|sc|jsx|styled)-/.test(c) && !/[0-9a-f]{6,}/i.test(c) && !/\d{3,}/.test(c);
  }

  function selectorFor(el) {
    var attrs = ['data-testid', 'data-test', 'data-id', 'itemprop'];
    if (el.id && !/\d{4,}/.test(el.id) && unique('#' + escapeIdent(el.id), el)) return '#' + escapeIdent(el.id);
    for (var i = 0; i < attrs.length; i++) {
      var v = el.getAttribute && el.getAttribute(attrs[i]);
      if (v) {
        var s = '[' + attrs[i] + '="' + String(v).replace(/"/g, '\\"') + '"]';
        if (unique(s, el)) return s;
      }
    }

    var parts = [];
    var node = el;
    while (node && node.nodeType === 1 && node !== document.documentElement) {
      var part = node.tagName.toLowerCase();
      if (node.id && !/\d{4,}/.test(node.id)) {
        parts.unshift('#' + escapeIdent(node.id));
        break;
      }
      var classes = Array.prototype.filter.call(node.classList || [], stableClass).slice(0, 2);
      if (classes.length) part += '.' + classes.map(escapeIdent).join('.');
      var parent = node.parentElement;
      if (parent) {
        var same = Array.prototype.filter.call(parent.children, function (c) { return c.tagName === node.tagName; });
        if (same.length > 1 && !unique(parts.concat(part).join(' > '), node)) {
          part += ':nth-of-type(' + (same.indexOf(node) + 1) + ')';
        }
      }
      parts.unshift(part);
      var candidate = parts.join(' > ');
      if (unique(candidate, el)) return candidate;
      node = parent;
    }
    return parts.join(' > ');
  }

  function show(el) {
    if (!el) { box.style.display = 'none'; return; }
    var r = el.getBoundingClientRect();
    box.style.display = 'block';
    box.style.left = r.left + 'px';
    box.style.top = r.top + 'px';
    box.style.width = r.width + 'px';
    box.style.height = r.height + 'px';
    box.style.borderColor = COLORS[mode];
    box.style.background = COLORS[mode] + '26';
  }

  document.addEventListener('mouseover', function (e) {
    hovered = e.target === document.documentElement || e.target === box ? null : e.target;
    show(hovered);
  }, true);

  document.addEventListener('click', function (e) {
    e.preventDefault();
    e.stopPropagation();
    var el = e.target;
    if (!el || el === document.documentElement || el === document.body) return;
    var selector = selectorFor(el);
    var mark = document.createElement('div');
    var r = el.getBoundingClientRect();
    mark.style.cssText = 'position:absolute;pointer-events:none;z-index:2147483646;border:2px dashed ' + COLORS[mode] +
      ';left:' + (r.left + window.scrollX) + 'px;top:' + (r.top + window.scrollY) + 'px;width:' + r.width + 'px;height:' + r.height + 'px';
    document.body.appendChild(mark);
    chosen.push(mark);
    parent.postMessage({
      type: 'wcd-selected',
      mode: mode,
      selector: selector,
      preview: (el.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 120),
      matches: (function () { try { return document.querySelectorAll(selector).length; } catch (err) { return 0; } })(),
    }, '*');
  }, true);

  ['submit', 'mousedown', 'mouseup'].forEach(function (t) {
    document.addEventListener(t, function (e) { e.preventDefault(); e.stopPropagation(); }, true);
  });

  window.addEventListener('message', function (e) {
    if (e.data && e.data.type === 'mode' && COLORS[e.data.mode]) mode = e.data.mode;
    if (e.data && e.data.type === 'clear') { chosen.forEach(function (m) { m.remove(); }); chosen = []; }
  });
})();
