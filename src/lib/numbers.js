'use strict';

/**
 * Parses "$1,299.00", "1.299,00 €", "₹ 74,999", "4.5k", "−12%" into a Number.
 * Returns null when no number is present.
 */
function parseNumber(raw, regex) {
  if (raw == null) return null;
  let s = String(raw);

  if (regex) {
    const m = new RegExp(regex, 'i').exec(s);
    if (!m) return null;
    s = m[1] !== undefined ? m[1] : m[0];
  }

  const m = s.replace(/−/g, '-').match(/-?\d[\d\s.,']*\d|-?\d/);
  if (!m) return null;
  let n = m[0].replace(/[\s']/g, '');

  const lastDot = n.lastIndexOf('.');
  const lastComma = n.lastIndexOf(',');
  if (lastDot !== -1 && lastComma !== -1) {
    // Whichever separator comes last is the decimal mark.
    const decimal = lastDot > lastComma ? '.' : ',';
    const thousands = decimal === '.' ? ',' : '.';
    n = n.split(thousands).join('').replace(decimal, '.');
  } else if (lastComma !== -1) {
    // "1,299" -> thousands; "12,5" / "1299,99" -> decimal comma
    n = /,\d{1,2}$/.test(n) && n.split(',').length === 2 ? n.replace(',', '.') : n.replace(/,/g, '');
  } else if (lastDot !== -1 && n.split('.').length > 2) {
    n = n.replace(/\./g, ''); // "1.299.000"
  }

  let value = parseFloat(n);
  if (!Number.isFinite(value)) return null;
  const suffix = /\d\s*([kKmMbB])\b/.exec(s.slice(m.index + m[0].length - 1));
  if (suffix) value *= { k: 1e3, m: 1e6, b: 1e9 }[suffix[1].toLowerCase()];
  return value;
}

/**
 * @param {{label:string, selector?:string, regex?:string}[]} rules
 * @param {Record<string,string[]>} rawBySelector texts captured in the browser, keyed by selector
 * @param {string} pageText full normalized text, used for regex-only rules
 */
function extractNumbers(rules = [], rawBySelector = {}, pageText = '') {
  const out = [];
  for (const rule of rules) {
    const sources = rule.selector ? rawBySelector[rule.selector] || [] : [pageText];
    for (const raw of sources) {
      const value = parseNumber(raw, rule.regex);
      if (value !== null) {
        out.push({ label: rule.label, value, rawText: String(raw).slice(0, 120) });
        break; // first match per rule
      }
    }
  }
  return out;
}

module.exports = { parseNumber, extractNumbers };
