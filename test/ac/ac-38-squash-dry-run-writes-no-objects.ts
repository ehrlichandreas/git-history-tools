/* AC-38 -- § 0 (D2, commit a4e8b9f): a dry run writes no git objects
 * either, not just no ref -- `.git/objects` must be byte-identical
 * (same file listing, same `git count-objects -v`) before and after
 * `plan`, and a dry-run `apply`/`tail` (no --apply). */
import path from 'node:path';
import * as H from '../lib/harness.ts';
const T = H.T;

H.requireBin('release-squash');

function assertNoObjectsWritten(label: string, repo: string, gpg: H.Gpg, args: string[]): void {
  const before = H.objectStoreSnapshot(repo, gpg);
  const r = H.runBin('release-squash', args, { gnupgHome: gpg.gnupgHome });
  const after = H.objectStoreSnapshot(repo, gpg);
  T.exit(label + ': exit 0', r, 0);
  if (r.missing) return;
  const diff = H.objectStoreDiff(before, after);
  T.eq(label + ': no new loose objects or packs appeared', diff.added, []);
  T.eq(label + ': no existing object file disappeared', diff.removed, []);
  T.check(label + ': git count-objects -v report is unchanged',
    !diff.countChanged, 'before:\n' + before.countObjects + 'after:\n' + after.countObjects);
}

const gpg = H.setupGpg('ac38');
if (gpg) {
  const repo = H.initRepo('ac38', gpg);
  H.commit(repo, gpg, 'root', { 'a.txt': 'one\n' });
  H.tagSigned(repo, gpg, 'v1', 'release v1');
  H.commit(repo, gpg, 'tail commit', { 'a.txt': 'two\n' });

  assertNoObjectsWritten('AC-38 plan', repo, gpg, ['plan', repo]);
}

const gpg2 = H.setupGpg('ac38b');
if (gpg2) {
  const repo2 = H.initRepo('ac38b', gpg2);
  H.commit(repo2, gpg2, 'root', { 'a.txt': 'one\n' });
  H.tagSigned(repo2, gpg2, 'v1', 'release v1');

  assertNoObjectsWritten('AC-38 apply (dry run, no --apply)', repo2, gpg2,
    ['apply', repo2, '--map', path.join(H.freshDir("ac38-apply-map"), "ac38-apply-map.txt")]);
}

const gpg3 = H.setupGpg('ac38c');
if (gpg3) {
  const repo3 = H.initRepo('ac38c', gpg3);
  H.commit(repo3, gpg3, 'root', { 'a.txt': 'one\n' });
  H.tagSigned(repo3, gpg3, 'v1', 'release v1');
  H.commit(repo3, gpg3, 'tail commit', { 'a.txt': 'two\n' });

  assertNoObjectsWritten('AC-38 tail (dry run, no --apply)', repo3, gpg3, ['tail', repo3]);
}

T.finish();
