/* AC-83 -- D21 (Scout N4): git-release-squash on a bare repository. A
 * bare repository is a valid top level (§ 0), but `tail --apply` and
 * `apply --apply` ran their dirty check, `git status`, which needs a work
 * tree: a GitError stack trace, exit 1. A bare repository has no work
 * tree to be dirty, so the check is skipped and the run is a normal one:
 * exit 0, verify OK, the refs moved, the bundle next to the bare repo. */
import path from 'node:path';
import * as H from '../lib/harness.ts';
const T = H.T;

H.requireBin('git-release-squash');

const outside = H.freshDir('ac83-files');

for (const [label, args] of [
  ['tail --apply', (r: string) => ['tail', r, '--apply']],
  ['tail --tag --apply', (r: string) => ['tail', r, '--tag=v2', '--message=release two', '--apply']],
  ['apply --apply', (r: string) => ['apply', r, '--map', path.join(outside, 'map-' + path.basename(r)), '--apply']],
] as [string, (r: string) => string[]][]) {
  const gpg = H.setupGpg('ac83');
  if (!gpg) continue;
  const src = H.initRepo('ac83-src', gpg);
  H.commit(src, gpg, 'first', { 'a.txt': 'a\n' });
  H.tagSigned(src, gpg, 'v1', 'release one');
  H.commit(src, gpg, 'second', { 'a.txt': 'a b\n' });
  if (label === 'apply --apply') H.tagSigned(src, gpg, 'v2', 'release two');
  const bare = path.join(H.freshDir('ac83-bare'), 'r.git');
  H.gitRaw(src, gpg, ['clone', '-q', '--bare', src, bare]);
  const git = H.gitIn(bare, gpg);
  git(['config', 'user.name', 'GHT Test']);
  git(['config', 'user.email', H.FIXTURE_EMAIL]);
  git(['config', 'user.signingkey', gpg.fingerprint]);
  const before = H.gitRaw(bare, gpg, ['for-each-ref', '--format=%(refname) %(objectname)']);
  const l = 'AC-83 [' + label + ', bare]';

  const r = H.runBin('git-release-squash', args(bare), { gnupgHome: gpg.gnupgHome });
  T.exit(l + ': exit 0', r, 0);
  T.check(l + ': no stack trace', !/^\s+at /m.test(r.stderr), r.stderr);
  T.contains(l + ': verify: signatures: OK', r.stdout, 'verify: signatures: OK');
  T.check(l + ': refs moved', H.gitRaw(bare, gpg, ['for-each-ref', '--format=%(refname) %(objectname)']) !== before, '');
  T.check(l + ': the bundle sits next to the bare repo', H.findBackupBundle(bare) !== null, '');
}

T.finish();
