/* AC-93 -- § 2.1 / D22 (Reviewer R2): many secret hits in one blob are
 * cheap. The filter that drops a hit inside a longer one compared every
 * pair of hits: 40000 `API_KEY=` lines in one file took 12 s, of which
 * the regexes took 21 ms. It is one sort and one sweep now. The same file
 * reports every line once, and a token inside a longer hit still once. */
import * as H from '../lib/harness.ts';
const T = H.T;

H.requireBin('git-leak-scan');

const LINES = 40000;
const BOUND_MS = 6000;
const GHP = 'ghp_' + 'aB3'.repeat(12);

const gpg = H.setupGpg('ac93');
if (gpg) {
  const repo = H.initRepo('ac93', gpg);
  const body = Array.from({ length: LINES }, (_, i) => 'API_KEY=AbCdEfGhIjKl' + String(i).padStart(8, '0') + 'Mn').join('\n') +
    '\nGITHUB_TOKEN=' + GHP + '\n';
  H.commit(repo, gpg, 'many keys', { 'keys.env': body });
  const t0 = Date.now();
  const r = H.runBin('git-leak-scan', ['scan', repo], { gnupgHome: gpg.gnupgHome, timeout: 120000 });
  const ms = Date.now() - t0;
  T.exit('AC-93: hits, exit 1', r, 1);
  const lines = r.stdout.split('\n').filter((x) => x.startsWith('scan: secret '));
  T.eq('AC-93: one hit per line, the token inside GITHUB_TOKEN= not again', lines.length, LINES + 1);
  T.eq('AC-93: the GITHUB_TOKEN line is the longer hit', lines.filter((x) => x.includes(GHP)).length, 1);
  T.check('AC-93: within ' + BOUND_MS + ' ms', ms < BOUND_MS, ms + ' ms');
}

T.finish();
