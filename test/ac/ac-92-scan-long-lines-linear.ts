/* AC-92 -- § 2.1 / D22 (Reviewer R1): `scan` stays fast on a long line
 * that is one run of characters a pattern can match. RE_EMAIL's local
 * part, RE_HOSTNAME's labels and RE_SECRET_KV's name prefix were
 * unbounded, so every start position on such a run re-read the rest of
 * it: quadratic, about an hour for 1 MB and days for 10 MB, for a line
 * of hex, `a_a_…`, `ab.ab.…`, `eyJ…` or joined UUIDs. They are bounded
 * now (local part 64, label 63, 16 labels, 8 name parts), and each of
 * these 1 MB single-line files scans in seconds. */
import crypto from 'node:crypto';
import * as H from '../lib/harness.ts';
const T = H.T;

H.requireBin('git-leak-scan');

const N = 1 << 20;
const BOUND_MS = 15000;
const rep = (s: string) => s.repeat(Math.ceil(N / s.length)).slice(0, N);
const SHAPES: [string, () => string][] = [
  ['hex', () => crypto.randomBytes(N / 2).toString('hex')],
  ['a_a_', () => rep('a_')],
  ['ab.ab.', () => rep('ab.')],
  ['abcd-', () => rep('abcd-')],
  ['eyJ', () => rep('eyJ')],
  ['joined UUIDs', () => Array.from({ length: Math.ceil(N / 37) }, () => crypto.randomUUID()).join('-').slice(0, N)],
  ['base64url', () => crypto.randomBytes(N).toString('base64url').slice(0, N)],
  ['x_token: ', () => rep('x_token: ')],
];

for (const [label, make] of SHAPES) {
  const gpg = H.setupGpg('ac92');
  if (!gpg) continue;
  const repo = H.initRepo('ac92', gpg);
  H.commit(repo, gpg, 'one long line', { 'long.txt': make() + '\n' });
  const l = 'AC-92 [1 MB of ' + label + ']';
  const t0 = Date.now();
  const r = H.runBin('git-leak-scan', ['scan', repo], { gnupgHome: gpg.gnupgHome, timeout: 120000 });
  const ms = Date.now() - t0;
  T.check(l + ': exit 0 or 1, the scan finished', r.status === 0 || r.status === 1, 'status ' + r.status + ' signal ' + r.signal);
  T.check(l + ': no stack trace', !/^\s+at /m.test(r.stderr), r.stderr.slice(0, 500));
  T.check(l + ': within ' + BOUND_MS + ' ms', ms < BOUND_MS, ms + ' ms');
}

T.finish();
