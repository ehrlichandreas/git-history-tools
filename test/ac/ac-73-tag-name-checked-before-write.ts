/* AC-73 -- D20: a tag name the caller gives (`git-release-squash tail
 * --tag=<tag>`, `git-sign tag <repo> <tag>`) is checked with `git
 * check-ref-format` before anything else, dry run or `--apply`: an invalid
 * name, or one starting with `-`, is a usage error, exit 2. `tail
 * --tag='bad name'` used to pass its dry run, then on `--apply` move the
 * branch to "<name> bad name: ..." first, fail to create the tag, and
 * crash with a stack trace, leaving the branch moved and no tag. */
import fs from 'node:fs';
import * as H from '../lib/harness.ts';
const T = H.T;

H.requireBin('git-release-squash');
H.requireBin('git-sign');

const BAD = ['bad name', '-x', 'a..b', 'x.lock', 'x~1', ''];

const gpg = H.setupGpg('ac73');
if (gpg) {
  const repo = H.initRepo('ac73', gpg);
  H.commit(repo, gpg, 'first', { 'a.txt': 'one\n' });
  H.tagSigned(repo, gpg, 'v0', 'release zero');
  H.commit(repo, gpg, 'second', { 'a.txt': 'two\n' });
  const policy = H.writePolicy('ac73', { signingKey: gpg.fingerprint });
  const opts = { gnupgHome: gpg.gnupgHome };
  const refsBefore = H.gitRaw(repo, gpg, ['show-ref']);
  const objectsBefore = H.objectStoreSnapshot(repo, gpg);

  for (const name of BAD) {
    for (const apply of [false, true]) {
      const extra = apply ? ['--apply'] : [];
      const l = ' ' + JSON.stringify(name) + (apply ? ' --apply' : '') + ']';
      const t = H.runBin('git-release-squash', ['tail', repo, '--tag=' + name, '--message=x'].concat(extra), opts);
      T.exit('AC-73 [tail --tag=' + l + ': usage error, exit 2', t, 2);
      T.eq('AC-73 [tail --tag=' + l + ': one stderr line naming the name',
        t.stderr, 'git-release-squash: --tag: ' + JSON.stringify(name) + ' is not a valid tag name\n');
      T.eq('AC-73 [tail --tag=' + l + ': nothing on stdout', t.stdout, '');
      const s = H.runBin('git-sign', ['tag', repo, name, '--message=x', '--date=auto', '--policy=' + policy].concat(extra), opts);
      T.exit('AC-73 [git-sign tag' + l + ': usage error, exit 2', s, 2);
      /* An empty positional is no <tag> at all: `missing <tag>`. */
      T.eq('AC-73 [git-sign tag' + l + ': one stderr line naming the name', s.stderr,
        name === '' ? 'git-sign: missing <tag>\n' : 'git-sign: <tag>: ' + JSON.stringify(name) + ' is not a valid tag name\n');
      T.eq('AC-73 [git-sign tag' + l + ': nothing on stdout', s.stdout, '');
    }
  }
  T.eq('AC-73: no ref moved (main stays, no tag created)', H.gitRaw(repo, gpg, ['show-ref']), refsBefore);
  T.eq('AC-73: no object written', JSON.stringify(H.objectStoreDiff(objectsBefore, H.objectStoreSnapshot(repo, gpg))),
    JSON.stringify({ added: [], removed: [], countChanged: false }));
  T.eq('AC-73: no backup bundle', H.findBackupBundle(repo), null);

  /* A valid name with a slash still works, end to end. */
  const ok = H.runBin('git-release-squash', ['tail', repo, '--tag=release/v1', '--message=release one', '--apply'], opts);
  T.exit('AC-73 [tail --tag=release/v1 --apply]: exit 0', ok, 0);
  T.eq('AC-73 [tail --tag=release/v1 --apply]: the tag exists on the new tip',
    H.revParse(repo, gpg, 'refs/tags/release/v1^{commit}'), H.revParse(repo, gpg, 'refs/heads/main'));
  T.check('AC-73: the bundle of that run exists', H.findBackupBundle(repo) !== null && fs.existsSync(H.findBackupBundle(repo)!));
}

T.finish();
