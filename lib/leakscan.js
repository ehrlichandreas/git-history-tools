'use strict';
/* § 2.1: the built-in leak categories, shared between `ght-scan scan` and
 * history-rewrite's own "rule sources clean" verification check. Pure text
 * functions -- no git, no filesystem -- so they are equally usable against a
 * real blob's content or a synthetic one-line "blob" made of a rule's own
 * replacement text. */

const RE_EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const RE_URL = /https?:\/\/[^\s)"'`>\]]+/g;
const RE_LOCAL_PATH = /(?:\/Users\/[^\s"'`<>]+|\/home\/[^\s"'`<>]+|C:\\Users\\[^\s"'`<>]+)/g;
const RE_HOSTNAME = /\b(?:[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?\.)+(?:local|internal|corp|lan)(?:\.[A-Za-z0-9-]+)*\b/gi;
const RE_IP = /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g;
const RE_SECRET_KV = /\b(?:token|secret|key|password)=[A-Za-z0-9_-]{20,}/gi;
const RE_SECRET_PEM = /-----BEGIN [A-Za-z0-9 ]*PRIVATE KEY-----/g;

const IGNORED_IPS = new Set(['127.0.0.1', '0.0.0.0']);

/** Built-in categories, applied to a text blob; returns [{category, match}]. */
function scanBuiltins(text) {
  const hits = [];
  const add = (category, re) => {
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(text))) {
      if (category === 'ip' && IGNORED_IPS.has(m[0])) continue;
      hits.push({ category, match: m[0] });
      if (m[0].length === 0) re.lastIndex++;
    }
  };
  add('email', RE_EMAIL);
  add('url', RE_URL);
  add('local-path', RE_LOCAL_PATH);
  add('hostname', RE_HOSTNAME);
  add('ip', RE_IP);
  add('secret', RE_SECRET_KV);
  add('secret', RE_SECRET_PEM);
  return hits;
}

/** The PEM-private-key check alone, run against raw bytes regardless of
 * whether the blob is binary (§ 2.1: a binary-encoded key must not be
 * skipped just because it fails the text-shaped checks). */
function scanPemInBuffer(buf) {
  const hits = [];
  const text = buf.toString('latin1'); // 1 byte <-> 1 char, safe for an ASCII PEM header search
  let m;
  RE_SECRET_PEM.lastIndex = 0;
  while ((m = RE_SECRET_PEM.exec(text))) hits.push({ category: 'secret', match: m[0] });
  return hits;
}

/** User-supplied --terms: case-insensitive literal substrings. terms is an
 * array of lowercase term strings. Returns [{category: 'term', match}],
 * `match` preserving the casing as found in `text`. */
function scanTerms(text, terms) {
  const hits = [];
  const lower = text.toLowerCase();
  for (const term of terms) {
    if (!term) continue;
    let from = 0;
    for (;;) {
      const i = lower.indexOf(term, from);
      if (i === -1) break;
      hits.push({ category: 'term', match: text.slice(i, i + term.length) });
      from = i + term.length;
    }
  }
  return hits;
}

/** Parses a terms/allow-style file: one entry per line, blank/# lines
 * skipped. For terms, entries are lowercased (matching is case-insensitive);
 * for allow, entries are kept verbatim (matching is exact). */
function readLines(filePath, lowercase) {
  const fs = require('fs');
  const raw = fs.readFileSync(filePath, 'utf8');
  const out = [];
  for (const line of raw.split('\n')) {
    const l = line.replace(/\r$/, '');
    if (l === '' || l.startsWith('#')) continue;
    out.push(lowercase ? l.toLowerCase() : l);
  }
  return out;
}

/** Binary-blob convention shared with history-rewrite (§ 2.1 / § 3.1): a
 * NUL byte within the first 8000 bytes makes a blob "binary". */
function isBinary(buf) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

module.exports = { scanBuiltins, scanPemInBuffer, scanTerms, readLines, isBinary };
