/* AC-04 -- § 1.1: commits after the last tag are reported as the untagged
 * tail, not folded into any tag's count; and the "from the start of
 * history" wording when there are no tags at all yet. */
import * as H from '../lib/harness.ts';
const T = H.T;

H.requireBin('release-squash');

const gpg = H.setupGpg('ac04');
if (gpg) {
  const repo = H.initRepo('ac04', gpg);
  H.commit(repo, gpg, 'root', { 'a.txt': 'one\n' });
  H.tagSigned(repo, gpg, 'v1', 'release v1');
  H.commit(repo, gpg, 'post-release 1', { 'a.txt': 'two\n' });
  H.commit(repo, gpg, 'post-release 2', { 'a.txt': 'three\n' });

  const r = H.runBin('release-squash', ['plan', repo], { gnupgHome: gpg.gnupgHome });
  T.exit('AC-04 plan: exit 0', r, 0);
  if (!r.missing) {
    T.contains('AC-04: v1 itself still reported', r.stdout, 'plan: v1 folds 1 commit(s)');
    T.contains('AC-04: the 2 untagged commits after v1 are called out, not folded into v1',
      r.stdout, 'plan: 2 untagged commit(s) after v1 are not covered by plan');
    T.check('AC-04: v1\'s own fold count is NOT inflated by the untagged tail',
      /plan: v1 folds 1 commit\(s\)/.test(r.stdout), r.stdout);
  }
}

const gpg2 = H.setupGpg('ac04b');
if (gpg2) {
  const repo2 = H.initRepo('ac04b', gpg2);
  H.commit(repo2, gpg2, 'only commit, no tags yet', { 'a.txt': 'one\n' });
  H.commit(repo2, gpg2, 'second, still no tags', { 'a.txt': 'two\n' });

  const r2 = H.runBin('release-squash', ['plan', repo2], { gnupgHome: gpg2.gnupgHome });
  T.exit('AC-04b plan on a zero-tag repo: exit 0', r2, 0);
  if (!r2.missing) {
    T.contains('AC-04b: with zero tags, the untagged tail reads "from the start of history"',
      r2.stdout, 'plan: 2 untagged commit(s) from the start of history are not covered by plan');
    T.check('AC-04b: no per-tag lines at all', !r2.stdout.includes('plan: v'), r2.stdout);
  }
}

T.finish();
