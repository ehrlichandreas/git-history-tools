/* AC-97 -- § 1.3 / D21 (Scout N4): a NUL byte in `tail --tag`'s message
 * is a usage error up front, next to the empty-message check. It crashed
 * with a stack trace after the backup bundle was written: a NUL cannot be
 * passed on to git. Now exit 2, one stderr line, nothing on stdout, no
 * bundle and no ref moved, in a dry run too. */
import fs from 'node:fs';
import path from 'node:path';
import * as H from '../lib/harness.ts';
const T = H.T;

H.requireBin('git-release-squash');

const msg = path.join(H.freshDir('ac97-files'), 'nul.msg');
fs.writeFileSync(msg, Buffer.from('title\u0000hidden\n'));

for (const apply of [true, false]) {
  const gpg = H.setupGpg('ac97');
  if (!gpg) continue;
  const repo = H.initRepo('ac97', gpg);
  H.commit(repo, gpg, 'first', { 'a.txt': 'a\n' });
  H.tagSigned(repo, gpg, 'v1', 'release one');
  H.commit(repo, gpg, 'second', { 'a.txt': 'a b\n' });
  const refs = () => H.gitRaw(repo, gpg, ['for-each-ref', '--format=%(refname) %(objectname)']);
  const before = refs();
  const l = 'AC-97 [' + (apply ? '--apply' : 'dry run') + ']';

  const args = ['tail', repo, '--tag=v2', '--message-file=' + msg];
  if (apply) args.push('--apply');
  const r = H.runBin('git-release-squash', args, { gnupgHome: gpg.gnupgHome });
  T.exit(l + ': a usage error, exit 2', r, 2);
  T.eq(l + ': one stderr line', r.stderr, 'git-release-squash: --tag: the tag message contains a NUL byte\n');
  T.eq(l + ': nothing on stdout', r.stdout, '');
  T.eq(l + ': no ref moved', refs(), before);
  T.eq(l + ': no backup bundle', H.findBackupBundle(repo), null);
}

T.finish();
