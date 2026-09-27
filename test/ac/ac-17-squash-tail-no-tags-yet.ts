/* AC-17 -- § 1.3: `tail` needs no pre-existing tag at all -- a brand-new
 * repo with zero tags and an untagged HEAD squashes its WHOLE history
 * into one parentless commit, and does not itself create any tag. */
import * as H from '../lib/harness.ts';
const T = H.T;

H.requireBin('git-release-squash');

const gpg = H.setupGpg('ac17');
if (gpg) {
  const repo = H.initRepo('ac17', gpg);
  H.commit(repo, gpg, 'first ever commit', { 'a.txt': 'one\n' });
  H.commit(repo, gpg, 'second', { 'a.txt': 'two\n' });
  H.commit(repo, gpg, 'third, HEAD', { 'a.txt': 'three\n' });
  const headTreeBefore = H.treeOf(repo, gpg, 'HEAD');

  const applied = H.runBin('git-release-squash', ['tail', repo, '--apply'], { gnupgHome: gpg.gnupgHome });
  T.exit('AC-17 tail --apply on a zero-tag repo: exit 0', applied, 0);
  if (!applied.missing) {
    const log = H.log(repo, gpg, ['--oneline']);
    T.eq('AC-17: the whole history is now exactly 1 commit', log.split('\n').filter(Boolean).length, 1);
    const headSha = H.revParse(repo, gpg, 'HEAD');
    const raw = H.catFile(repo, gpg, headSha, '-p');
    T.check('AC-17: the single new commit has no parent line', !raw.includes('\nparent '), raw);
    T.eq('AC-17: tree is byte-identical to the original HEAD\'s tree', H.treeOf(repo, gpg, 'HEAD'), headTreeBefore);
    T.contains('AC-17: subject uses the "(untagged)" placeholder and the latest commit\'s own subject',
      raw, '(untagged): third, HEAD');

    const tags = H.log(repo, gpg, ['tag', '-l']);
    T.eq('AC-17: tail does not itself create any tag', tags.trim(), '');
  }
}

T.finish();
