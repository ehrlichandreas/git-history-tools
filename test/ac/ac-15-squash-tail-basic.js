'use strict';
/* AC-15 -- § 1.3: `tail` squashes only the untagged commits after the last
 * tag into one new commit, parented on that tag's commit, tree identical
 * to the original HEAD's tree, subject "<name> (untagged): <title>". */
const H = require('../lib/harness.js');
const T = H.T;

H.requireBin('ght-squash');

const gpg = H.setupGpg('ac15');
if (gpg) {
  const repo = H.initRepo('ac15', gpg);
  H.commit(repo, gpg, 'root', { 'a.txt': 'one\n' });
  H.tagSigned(repo, gpg, 'v1', 'release v1');
  H.commit(repo, gpg, 'tail 1', { 'a.txt': 'two\n' });
  H.commit(repo, gpg, 'tail 2 subject', { 'a.txt': 'three\n' });

  const headTreeBefore = H.treeOf(repo, gpg, 'HEAD');
  const v1Sha = H.revParse(repo, gpg, 'v1^{commit}'); /* v1 is an annotated tag -- a commit's parent is always a commit, never the tag object */
  const branch = H.branchName(repo, gpg);
  const headBefore = H.revParse(repo, gpg, 'HEAD');
  const v1RefBefore = H.revParse(repo, gpg, 'v1');

  const dry = H.runBin('ght-squash', ['tail', repo], { gnupgHome: gpg.gnupgHome });
  T.exit('AC-15 tail (dry run): exit 0', dry, 0);
  if (!dry.missing) {
    T.contains('AC-15 dry run: reports folding 2 commits', dry.stdout, 'tail: squashes 2 commit(s)');
    T.contains('AC-15 dry run: dry-run line present', dry.stdout, 'ght-squash: dry run, no ref changed (use --apply to write)');
  }

  const applied = H.runBin('ght-squash', ['tail', repo, '--apply'], { gnupgHome: gpg.gnupgHome });
  T.exit('AC-15 tail --apply: exit 0', applied, 0);
  if (!applied.missing) {
    const headSha = H.revParse(repo, gpg, 'HEAD');
    const headTreeAfter = H.treeOf(repo, gpg, 'HEAD');
    T.eq('AC-15: HEAD\'s tree is byte-identical to the original HEAD\'s tree', headTreeAfter, headTreeBefore);

    const raw = H.catFile(repo, gpg, headSha, '-p');
    T.check('AC-15: the new tail commit is parented on v1 (the last tag)',
      raw.includes('parent ' + v1Sha), raw);
    T.contains('AC-15: subject uses "(untagged): <title>" and the last tail commit\'s own subject as <title>',
      raw, '(untagged): tail 2 subject');

    const log = H.log(repo, gpg, ['--oneline']);
    const count = log.split('\n').filter(Boolean).length;
    T.eq('AC-15: HEAD\'s history is now exactly 2 commits (v1, then the one squashed tail)', count, 2);

    /* Bundle order: a bundle taken AFTER tail's write would carry the
     * branch's NEW tip (headSha) under refs/heads/<branch>, not the old
     * one -- comparing against the PRE-run sha catches that. */
    const bundlePath = H.findBackupBundle(repo);
    T.check('AC-15: tail --apply created a backup bundle', !!bundlePath, bundlePath);
    if (bundlePath) {
      const heads = H.bundleListHeads(bundlePath);
      T.eq('AC-15: the bundle\'s branch head is the PRE-tail commit (bundled before the rewrite)',
        heads['refs/heads/' + branch], headBefore);
      T.eq('AC-15: the bundle\'s v1 is unchanged -- still the PRE-tail tag (tail never touches v1)',
        heads['refs/tags/v1'], v1RefBefore);
      T.check('AC-15 sanity: tail actually moved the branch tip', headSha !== headBefore, headSha);
    }
  }
}

T.finish();
