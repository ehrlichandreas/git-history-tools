/* § 2.1: the built-in leak categories, shared between `git-leak-scan scan` and
 * git-history-rewrite's own "rule sources clean" verification check. Pure text
 * functions -- no git, no filesystem -- so they are equally usable against a
 * real blob's content or a synthetic one-line "blob" made of a rule's own
 * replacement text. */

export interface Hit {
  category: string;
  match: string;
}

/* Every repeat that can run along a long line is bounded (D22, Reviewer
 * R1): unbounded, each start position on a 1 MB run of matching
 * characters re-read the rest of it, quadratic (AC-92). Local part 64 and
 * domain 253 are RFC 5321's limits. */
const RE_EMAIL = /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,63}/g;
const RE_URL = /https?:\/\/[^\s)"'`>\]]+/g;
/* A home directory, which names its user (D22): `/Users/…`, `/home/…`,
 * `c:\users\…` in any case, `/root/…` (not inside a longer path or a URL)
 * and `~<name>/…`. A bare `~/…` names no one and is not a hit. */
/* One literal, not `new RegExp(...)`: esbuild drops an unused literal from
 * the bundles that never scan (dist/sign.mjs, dist/squash.mjs), but keeps
 * a constructor call. The five alternatives, in order: /Users/, /home/,
 * c:\users\ in any case, /root/ and ~<name>/. */
const RE_LOCAL_PATH =
  /\/Users\/[^\s"'`<>]+|\/home\/[^\s"'`<>]+|[Cc]:\\[Uu][Ss][Ee][Rr][Ss]\\[^\s"'`<>]+|(?<![A-Za-z0-9._~-])\/root\/[^\s"'`<>]+|(?<![A-Za-z0-9._\/~-])~[A-Za-z_][A-Za-z0-9_.-]*\/[^\s"'`<>]+/g;
/* A label is 1-63 characters (RFC 1035), at most 16 before the suffix and
 * 16 after it. */
const RE_HOSTNAME = /\b(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.){1,16}(?:local|internal|corp|lan)(?:\.[A-Za-z0-9-]{1,63}){0,16}\b/gi;
const RE_IP = /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g;
/* `<name><sep><value>` (D22): a name ending in token/secret/key/password,
 * or flat `apikey`, whole or after `_`, `.` or `-` (`API_KEY`,
 * `x-api-key`, `db.password`, `APIKEY`);
 * `=` or `:`, with optional spaces and quotes around it; a value of 20+
 * characters from the base64/url-safe set, dotted parts allowed, `=`
 * padding at the end. Groups: 1 quote after the name, 2/4 spaces, 3 the
 * separator, 5 quote before the value, 6 the value. */
const RE_SECRET_KV =
  /(?<![A-Za-z0-9])(?:[A-Za-z0-9]{1,64}[_.-]){0,8}(?:token|secret|key|password|apikey)(["']?)(\s*)([:=])(\s*)(["']?)([A-Za-z0-9_+\/-]+(?:\.[A-Za-z0-9_+\/-]+)*={0,2})/gi;
/* The same with a camelCase name (D22, Reviewer R3): case-sensitive, the
 * word right after a lowercase letter or digit (`authToken`, `dbPassword`,
 * `awsSecretAccessKey`). Never a bare `Key`: `sortKey` and `cacheKey` are
 * everywhere. Same groups, same keepKeyValue. */
const RE_SECRET_CAMEL =
  /(?<![A-Za-z0-9])(?:[A-Za-z0-9]{1,64}[_.-]){0,8}[A-Za-z0-9]{0,63}[a-z0-9](?:Token|Secret|Password|ApiKey|AccessKey|PrivateKey)(["']?)(\s*)([:=])(\s*)(["']?)([A-Za-z0-9_+\/-]+(?:\.[A-Za-z0-9_+\/-]+)*={0,2})/g;
const RE_SECRET_PEM = /-----BEGIN [A-Za-z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/g;
/* Well-known token shapes (D22). `digit`: the match must contain a digit,
 * so a placeholder or a word (`Bearer authentication-scheme`) is not one.
 * `mixed`: two of lowercase, uppercase and digit, which keeps
 * `glpat-xxxx…` quiet but misses no real token; the digit rule would miss
 * about 3 % of 20-character ones (D22). */
type PrefixRule = 'none' | 'digit' | 'mixed';
const SECRET_PREFIXES: { re: RegExp; rule: PrefixRule }[] = [
  { re: /(?<![A-Za-z0-9])(?:AKIA|ASIA)[0-9A-Z]{16}(?![A-Za-z0-9])/g, rule: 'none' },
  { re: /(?<![A-Za-z0-9_])gh[pousr]_[A-Za-z0-9]{36}(?![A-Za-z0-9])/g, rule: 'digit' },
  { re: /(?<![A-Za-z0-9])xox[bp]-[0-9]{6,}-[0-9A-Za-z-]{10,}/g, rule: 'none' },
  { re: /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, rule: 'none' },
  { re: /\bBearer [A-Za-z0-9._~+\/-]{20,}=*/g, rule: 'digit' },
  /* GitHub fine-grained, Stripe live secret/restricted, Google API, GitLab personal (Reviewer R3). */
  { re: /(?<![A-Za-z0-9_])github_pat_[A-Za-z0-9]{22}_[A-Za-z0-9]{59}(?![A-Za-z0-9_])/g, rule: 'mixed' },
  { re: /(?<![A-Za-z0-9_])[sr]k_live_[0-9A-Za-z]{24,99}(?![A-Za-z0-9])/g, rule: 'mixed' },
  { re: /(?<![A-Za-z0-9_-])AIza[0-9A-Za-z_-]{35}(?![A-Za-z0-9_-])/g, rule: 'mixed' },
  { re: /(?<![A-Za-z0-9_-])glpat-[0-9A-Za-z_-]{20}(?![A-Za-z0-9_-])/g, rule: 'mixed' },
];

/** A key=value hit is kept when it is the old compact form (`name=value`,
 * nothing around the `=`), or when its value has a digit: a spaced or `:`
 * form without one is ordinary code or config, not a secret (D22). */
function keepKeyValue(m: RegExpExecArray): boolean {
  const value = m[6];
  if (value.replace(/=+$/, '').length < 20) return false;
  const compact = m[1] === '' && m[2] === '' && m[3] === '=' && m[4] === '' && m[5] === '';
  return compact || /[0-9]/.test(value);
}

function prefixRuleHolds(rule: PrefixRule, match: string): boolean {
  if (rule === 'digit') return /[0-9]/.test(match);
  if (rule === 'none') return true;
  /* The prefix itself (`AIza`, `sk_live_`) has letters of its own: count the body only. */
  const body = match.replace(/^(?:github_pat_|[sr]k_live_|AIza|glpat-)/, '');
  return [/[a-z]/, /[A-Z]/, /[0-9]/].filter((re) => re.test(body)).length >= 2;
}

/** Every `secret` hit in `text`, in order; a hit inside a longer one
 * (`GITHUB_TOKEN=ghp_...`, `Bearer eyJ...`) is dropped, so a secret is
 * reported once (D22). */
function scanSecrets(text: string): Hit[] {
  const spans: { start: number; end: number; match: string }[] = [];
  const add = (re: RegExp, keep: (m: RegExpExecArray) => boolean) => {
    let m: RegExpExecArray | null;
    re.lastIndex = 0;
    while ((m = re.exec(text))) {
      if (keep(m)) spans.push({ start: m.index, end: m.index + m[0].length, match: m[0] });
    }
  };
  add(RE_SECRET_KV, keepKeyValue);
  add(RE_SECRET_CAMEL, keepKeyValue);
  add(RE_SECRET_PEM, () => true);
  for (const p of SECRET_PREFIXES) add(p.re, (m) => prefixRuleHolds(p.rule, m[0]));
  const inside = containedSpans(spans);
  return spans.filter((_, i) => !inside.has(i)).map((s) => ({ category: 'secret', match: s.match }));
}

/** The indexes of the spans that lie inside a strictly longer one. One
 * sort and one sweep (D22, Reviewer R2): comparing every pair took 12 s
 * for 40000 hits in one blob (AC-93). Sorted by start, then end
 * descending, a span is inside a longer one exactly when an earlier start
 * reaches its end, or a span with the same start ends later. */
function containedSpans(spans: { start: number; end: number }[]): Set<number> {
  const order = spans.map((_, i) => i).sort((a, b) => spans[a].start - spans[b].start || spans[b].end - spans[a].end);
  const inside = new Set<number>();
  let reach = -1;
  for (let i = 0; i < order.length;) {
    const start = spans[order[i]].start;
    const groupEnd = spans[order[i]].end;
    let j = i;
    for (; j < order.length && spans[order[j]].start === start; j++) {
      const end = spans[order[j]].end;
      if (reach >= end || groupEnd > end) inside.add(order[j]);
    }
    reach = Math.max(reach, groupEnd);
    i = j;
  }
  return inside;
}

const IGNORED_IPS = new Set(['127.0.0.1', '0.0.0.0']);

/** Built-in categories, applied to a text blob; returns [{category, match}]. */
export function scanBuiltins(text: string): Hit[] {
  const hits: Hit[] = [];
  const add = (category: string, re: RegExp) => {
    let m: RegExpExecArray | null;
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
  return hits.concat(scanSecrets(text));
}

/** The PEM-private-key check alone, run against raw bytes regardless of
 * whether the blob is binary (§ 2.1: a binary-encoded key must not be
 * skipped just because it fails the text-shaped checks). */
export function scanPemInBuffer(buf: Buffer): Hit[] {
  const hits: Hit[] = [];
  const text = buf.toString('latin1'); // 1 byte <-> 1 char, safe for an ASCII PEM header search
  let m: RegExpExecArray | null;
  RE_SECRET_PEM.lastIndex = 0;
  while ((m = RE_SECRET_PEM.exec(text))) hits.push({ category: 'secret', match: m[0] });
  return hits;
}

/** User-supplied --terms: case-insensitive literal substrings. terms is an
 * array of lowercase term strings. Returns [{category: 'term', match}],
 * `match` preserving the casing as found in `text`. */
export function scanTerms(text: string, terms: string[]): Hit[] {
  const hits: Hit[] = [];
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

/** Parses a terms/allow-style file's text: one entry per line, blank/#
 * lines skipped. For terms, entries are lowercased (matching is
 * case-insensitive); for allow, entries are kept verbatim (matching is
 * exact). */
export function parseLines(raw: string, lowercase: boolean): string[] {
  const out: string[] = [];
  for (const line of raw.split('\n')) {
    const l = line.replace(/\r$/, '');
    if (l === '' || l.startsWith('#')) continue;
    out.push(lowercase ? l.toLowerCase() : l);
  }
  return out;
}

/** Binary-blob convention shared with git-history-rewrite (§ 2.1 / § 3.1): a
 * NUL byte within the first 8000 bytes makes a blob "binary". */
export function isBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}
