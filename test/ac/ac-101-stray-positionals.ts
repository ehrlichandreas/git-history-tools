/* AC-101 -- § 0 (D23): a positional argument a subcommand does not take is
 * a usage error, `<bin>: unexpected argument: <arg>`, exit 2, as git-sign
 * already had it. git-release-squash, git-history-rewrite and
 * git-leak-scan ignored it, so `replace <repo> --rules <f> --apply
 * <typo>` rewrote the history anyway. Now nothing is written: no bundle,
 * no ref moved, nothing on stdout. */
import fs from 'node:fs';
import path from 'node:path';
import * as H from '../lib/harness.ts';
const T = H.T;

const BINS = ['git-release-squash', 'git-leak-scan', 'git-history-rewrite', 'git-sign'];
for (const b of BINS) H.requireBin(b);

const outside = H.freshDir('ac94-files');
const rules = path.join(outside, 'rules.tsv');
fs.writeFileSync(rules, 'alpha\tomega\n');
const src = path.join(outside, 'NOTICE');
fs.writeFileSync(src, 'notice\n');

const CASES: [string, (repo: string) => string[]][] = [
  ['git-release-squash', (r) => ['plan', r, 'stray']],
  ['git-release-squash', (r) => ['apply', r, '--map', path.join(outside, 'map-' + path.basename(r)), '--apply', 'stray']],
  ['git-release-squash', (r) => ['tail', r, 'stray', '--apply']],
  ['git-leak-scan', (r) => ['scan', r, 'stray']],
  ['git-history-rewrite', (r) => ['replace', r, '--rules', rules, '--apply', 'stray']],
  ['git-history-rewrite', (r) => ['add-file', r, src, 'stray', '--apply']],
  ['git-sign', (r) => ['commit', r, 'stray', '--message=x', '--date=auto']],
  ['git-sign', (r) => ['tag', r, 'v9', 'stray', '--message=x', '--date=auto']],
  ['git-sign', (r) => ['check', r, 'HEAD~1..HEAD', 'stray']],
  ['git-sign', (r) => ['resign-commits', r, 'HEAD~1..HEAD', 'stray', '--apply']],
];

for (const [bin, args] of CASES) {
  const gpg = H.setupGpg('ac94');
  if (!gpg) continue;
  const repo = H.initRepo('ac94', gpg);
  H.commit(repo, gpg, 'first', { 'a.txt': 'alpha\n' });
  H.tagSigned(repo, gpg, 'v1', 'release one');
  H.commit(repo, gpg, 'second', { 'a.txt': 'alpha beta\n' });
  const refs = () => H.gitRaw(repo, gpg, ['for-each-ref', '--format=%(refname) %(objectname)']);
  const before = refs();
  const a = args(repo);
  const l = 'AC-101 [' + bin + ' ' + a[0] + ']';

  const r = H.runBin(bin, a, { gnupgHome: gpg.gnupgHome });
  T.exit(l + ': a usage error, exit 2', r, 2);
  T.eq(l + ': one stderr line naming the argument', r.stderr, bin + ': unexpected argument: stray\n');
  T.eq(l + ': nothing on stdout', r.stdout, '');
  T.eq(l + ': no ref moved', refs(), before);
  T.eq(l + ': no backup bundle', H.findBackupBundle(repo), null);
}

T.finish();
