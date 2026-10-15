'use strict';

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function contains(text, keyword) {
  // Unicode-aware "whole word" match so "sale" does not match "wholesale".
  const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(keyword.trim())}(?![\\p{L}\\p{N}])`, 'iu');
  return re.test(text);
}

/**
 * Keyword alerts: which watched keywords APPEARED or DISAPPEARED between two
 * versions of the page text.
 * @returns {{appeared:string[], disappeared:string[]}}
 */
function keywordChanges(prevText, nextText, { added = [], removed = [] } = {}) {
  const appeared = added.filter((k) => k.trim() && !contains(prevText, k) && contains(nextText, k));
  const disappeared = removed.filter((k) => k.trim() && contains(prevText, k) && !contains(nextText, k));
  return { appeared, disappeared };
}

module.exports = { keywordChanges };
