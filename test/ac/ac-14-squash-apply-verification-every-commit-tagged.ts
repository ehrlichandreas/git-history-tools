/* AC-14 -- § 4.2 check 3: git-release-squash `apply` verifies every commit
 * reachable from HEAD is tagged (this check is skipped, and not printed,
 * for `tail`/`replace`/`add-file`). */
import path from 'node:path';
import * as H from '../lib/harness.ts';
const T = H.T;

H.requireBin('git-release-squash');

const gpg = H.setupGpg('ac14');
if (gpg) {
  const repo = H.initRepo('ac14', gpg);
  H.commit(repo, gpg, 'root', { 'a.txt': 'one\n' });
  H.tagSigned(repo, gpg, 'v1', 'release v1');

  const map = path.join(H.freshDir("ac14-apply-map"), "ac14-apply-map.txt");
  const r = H.runBin('git-release-squash', ['apply', repo, '--map', map, '--apply'], { gnupgHome: gpg.gnupgHome });
  T.exit('AC-14 apply --apply: exit 0', r, 0);
  if (!r.missing) {
    T.contains('AC-14: apply prints the "every commit tagged" check, and it is OK',
      r.stdout, 'verify: squash: every commit tagged: OK');
  }
}

const gpg2 = H.setupGpg('ac14b');
if (gpg2) {
  const repo2 = H.initRepo('ac14b', gpg2);
  H.commit(repo2, gpg2, 'root', { 'a.txt': 'one\n' });
  H.commit(repo2, gpg2, 'second, never tagged', { 'a.txt': 'two\n' });

  const tail = H.runBin('git-release-squash', ['tail', repo2, '--apply'], { gnupgHome: gpg2.gnupgHome });
  T.exit('AC-14b tail --apply: exit 0', tail, 0);
  if (!tail.missing) {
    T.check('AC-14b: tail\'s own report does NOT print the "every commit tagged" check -- its result is intentionally untagged',
      !tail.stdout.includes('every commit tagged'), tail.stdout);
  }
}

T.finish();
