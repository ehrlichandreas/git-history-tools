/* AC-103 -- § 4.1 (D23): every --apply that writes a backup bundle names
 * it. No tool printed the path; the bundle was there to restore from, but
 * the caller had to find it. Now the first stdout line of `apply`,
 * `tail`, `replace`, `add-file`, `resign-tags` and `resign-commits
 * --apply` is `backup: <path>`, the real path of the one bundle, which
 * `git bundle verify` accepts. A dry run prints no such line, and neither
 * do git-sign `commit`/`tag --apply`, which write no bundle. A refusal
 * after the bundle keeps the line (AC-74, AC-78, AC-91). */
import fs from 'node:fs';
import path from 'node:path';
import * as H from '../lib/harness.ts';
const T = H.T;

const BINS = ['git-release-squash', 'git-history-rewrite', 'git-sign'];
for (const b of BINS) H.requireBin(b);

const outside = H.freshDir('ac96-files');
const rules = path.join(outside, 'rules.tsv');
fs.writeFileSync(rules, 'alpha\tomega\n');
const src = path.join(outside, 'NOTICE');
fs.writeFileSync(src, 'notice\n');

type Args = (repo: string, policy: string) => string[];
const CASES: [string, Args, boolean][] = [
  ['git-release-squash', (r) => ['apply', r, '--map', path.join(outside, 'map-' + path.basename(r))], true],
  ['git-release-squash', (r) => ['tail', r], true],
  ['git-history-rewrite', (r) => ['replace', r, '--rules', rules], true],
  ['git-history-rewrite', (r) => ['add-file', r, src], true],
  ['git-sign', (r, p) => ['resign-tags', r, '--policy=' + p], true],
  ['git-sign', (r, p) => ['resign-commits', r, 'HEAD~1..HEAD', '--policy=' + p], true],
  ['git-sign', (r, p) => ['commit', r, '--message=third', '--date=auto', '--policy=' + p], false],
  ['git-sign', (r, p) => ['tag', r, 'v9', '--message=nine', '--date=auto', '--policy=' + p], false],
];

for (const [bin, args, bundles] of CASES) {
  for (const apply of [false, true]) {
    const gpg = H.setupGpg('ac96');
    if (!gpg) continue;
    const policy = H.writePolicy('ac96', { signingKey: gpg.fingerprint, timezone: 'UTC' });
    const repo = H.initRepo('ac96', gpg);
    H.commit(repo, gpg, 'first', { 'a.txt': 'alpha\n' }, { date: '2020-01-01T10:00:00 +0000' });
    /* resign-tags needs a tag to re-sign (unsigned), the others a signed
     * one to verify; `apply` needs HEAD tagged, `commit` something staged. */
    const a = args(repo, policy);
    if (a[0] === 'resign-tags') H.tagAnnotatedUnsigned(repo, gpg, 'v1', 'release one');
    else H.tagSigned(repo, gpg, 'v1', 'release one');
    H.commit(repo, gpg, 'second', { 'a.txt': 'alpha beta\n' }, { date: '2020-01-02T10:00:00 +0000' });
    if (a[0] === 'apply') H.tagSigned(repo, gpg, 'v2', 'release two');
    if (a[0] === 'commit') {
      fs.writeFileSync(path.join(repo, 'b.txt'), 'b\n');
      H.gitIn(repo, gpg)(['add', 'b.txt']);
    }
    if (apply) a.push('--apply');
    const l = 'AC-103 [' + bin + ' ' + a[0] + (apply ? ' --apply' : ', dry run') + ']';

    const r = H.runBin(bin, a, { gnupgHome: gpg.gnupgHome });
    T.exit(l + ': exit 0', r, 0);
    const lines = r.stdout.split('\n').filter((x) => x.startsWith('backup: '));
    const bundle = H.findBackupBundle(repo);
    if (apply && bundles) {
      T.check(l + ': one bundle', bundle !== null, '');
      if (!bundle) continue;
      T.eq(l + ': the first stdout line names it', r.stdout.split('\n')[0], 'backup: ' + fs.realpathSync(bundle));
      T.eq(l + ': exactly one backup line', lines.length, 1);
      T.exit(l + ': git bundle verify accepts it', H.gitIn(repo, gpg)(['bundle', 'verify', '-q', bundle]), 0);
    } else {
      T.eq(l + ': no bundle', bundle, null);
      T.eq(l + ': no backup line', lines.join(' '), '');
    }
  }
}

T.finish();
