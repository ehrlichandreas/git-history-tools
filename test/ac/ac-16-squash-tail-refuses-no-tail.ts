/* AC-16 -- § 1.3: `tail` refuses when HEAD is already tagged (there is no
 * untagged tail to squash). */
import * as H from '../lib/harness.ts';
const T = H.T;

H.requireBin('release-squash');

const gpg = H.setupGpg('ac16');
if (gpg) {
  const repo = H.initRepo('ac16', gpg);
  H.commit(repo, gpg, 'root', { 'a.txt': 'one\n' });
  H.tagSigned(repo, gpg, 'v1', 'release v1');

  const dry = H.runBin('release-squash', ['tail', repo], { gnupgHome: gpg.gnupgHome });
  T.exit('AC-16 tail (dry run) refuses when HEAD is already tagged', dry, 1);
  if (!dry.missing) T.contains('AC-16: names "HEAD is already tagged, nothing to squash"',
    dry.stderr, 'HEAD is already tagged, nothing to squash');

  const applied = H.runBin('release-squash', ['tail', repo, '--apply'], { gnupgHome: gpg.gnupgHome });
  T.exit('AC-16 tail --apply refuses too', applied, 1);
  if (!applied.missing) {
    const refsAfter = H.gitRaw(repo, gpg, ['show-ref']);
    T.contains('AC-16: v1 is still present (nothing written)', refsAfter, 'refs/tags/v1');
  }
}

T.finish();
