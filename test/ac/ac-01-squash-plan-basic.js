'use strict';
/* AC-01 -- docs/SPECIFICATION.md § 1.1 `release-squash plan`: per-tag
 * fold-count/subject lines, the tree-equality "OK" line, and a tag sitting
 * on the repo's own root commit (no prior tag to fold from).
 *
 * `<tag-short>` in the fold/tree-equality lines is a PREVIEW of the new
 * squash commit's short sha -- NOT the original tag's own commit sha, and
 * also NOT reproducible by cross-checking against what `apply --apply`
 * actually writes later: the written commit is GPG-signed, and the
 * signature is embedded in the commit object itself, so the real,
 * finally-written sha necessarily differs from any unsigned preview
 * computed ahead of time. `<tag-short>` is therefore only checked
 * STRUCTURALLY here (looks like a short sha, and the fold line and the
 * tree-equality line for the same tag print the exact same value) rather
 * than against a hand-reimplemented preview algorithm or a later write. */
const H = require('../lib/harness.js');
const T = H.T;

H.requireBin('ght-squash');

const gpg = H.setupGpg('ac01');
if (gpg) {
  const repo = H.initRepo('ac01', gpg);

  const c0 = H.commit(repo, gpg, 'root commit', { 'a.txt': 'one\n' });
  H.tagSigned(repo, gpg, 'v1', 'release v1');
  const rootShort = H.shortSha(repo, gpg, c0.sha);

  H.commit(repo, gpg, 'second', { 'a.txt': 'two\n' });
  const c2 = H.commit(repo, gpg, 'third', { 'a.txt': 'three\n' });
  H.tagSigned(repo, gpg, 'v2', 'release v2');

  const r = H.runBin('ght-squash', ['plan', repo], { gnupgHome: gpg.gnupgHome });
  T.exit('AC-01 plan: exit 0', r, 0);
  if (!r.missing) {
    T.contains('AC-01 plan: v1 (root commit, 1 commit folded) line mentions tag and count',
      r.stdout, 'plan: v1 folds 1 commit(s)');
    const foldV1 = /plan: v1 folds 1 commit\(s\) \(([0-9a-f]{4,40})\.\.([0-9a-f]{4,40})\)/.exec(r.stdout);
    T.check('AC-01 plan: v1\'s fold line has a "(<oldest-short>..<tag-short>)" range of short shas', !!foldV1, r.stdout);
    if (foldV1) {
      const v1Short = foldV1[2];
      T.eq('AC-01 plan: v1\'s range starts at the real oldest (and only) folded commit\'s own short sha',
        foldV1[1], rootShort);
      T.contains('AC-01 plan: v1 tree-equality line uses the SAME tag-short the fold line just previewed',
        r.stdout, 'plan: v1 tree equals ' + v1Short + '\'s own tree: OK');
    }

    T.contains('AC-01 plan: v2 folds the 2 commits since v1',
      r.stdout, 'plan: v2 folds 2 commit(s)');
    const foldV2 = /plan: v2 folds 2 commit\(s\) \(([0-9a-f]{4,40})\.\.([0-9a-f]{4,40})\)/.exec(r.stdout);
    T.check('AC-01 plan: v2\'s fold line has a "(<oldest-short>..<tag-short>)" range of short shas', !!foldV2, r.stdout);
    if (foldV2) {
      const v2Short = foldV2[2];
      T.contains('AC-01 plan: v2 tree-equality line uses the SAME tag-short the fold line just previewed',
        r.stdout, 'plan: v2 tree equals ' + v2Short + '\'s own tree: OK');
    }

    T.check('AC-01 plan: v1\'s pair of lines precedes v2\'s pair (oldest tag first)',
      r.stdout.indexOf('plan: v1') < r.stdout.indexOf('plan: v2'),
      r.stdout);
    T.check('AC-01 plan: no untagged-tail line (HEAD is exactly v2)',
      !r.stdout.includes('untagged commit'), r.stdout);
  }

  const dirty = H.runBin('ght-squash', ['plan', repo + '-does-not-exist'], { gnupgHome: gpg.gnupgHome });
  T.exit('AC-01 fixture: plan refuses a path that is not a git repo', dirty, 1);
  if (!dirty.missing) {
    T.contains('AC-01: "not a git repository" names the path', dirty.stderr, 'not a git repository');
  }
}

T.finish();
