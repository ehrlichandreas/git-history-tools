'use strict';
/* AC-37 -- § 1.3 (D2, commit a4e8b9f): releasing step by step with
 * `tail --tag` must produce exactly the same history as pre-tagging
 * every release and running `apply` once over the whole thing -- same
 * tree, date and subject per commit. This is the `--tag` counterpart to
 * AC-35 (which covers the untagged-tail/apply mix); here BOTH releases
 * go through a tag, one via a real `git tag -s` before a single `apply`,
 * the other via `tail --tag` called twice, once per release. */
const path = require('path');
const H = require('../lib/harness.js');
const T = H.T;

function identDate(repo, gpg, rev, field) {
  const raw = H.catFile(repo, gpg, rev, '-p');
  const m = new RegExp('^' + field + ' .* (\\d+ [+-]\\d{4})$', 'm').exec(raw);
  return m ? m[1] : null;
}
function subjectOf(repo, gpg, rev) {
  const raw = H.catFile(repo, gpg, rev, '-p');
  const lines = raw.split('\n');
  const blank = lines.indexOf('');
  return blank >= 0 ? lines[blank + 1] : null;
}
function rowsKey(rows) { return rows.map(r => r.tree + '\t' + r.date + '\t' + r.subject).join('\n'); }

H.requireBin('ght-squash');

/* Repo A: both releases tagged up front (real `git tag -s`, with the
 * SAME message text `tail --tag` will later be given), one `apply`. */
function buildApplyAll(label, gpg) {
  const repo = H.initRepo(label, gpg);
  H.commit(repo, gpg, 'root', { 'a.txt': 'one\n' });
  H.tagSigned(repo, gpg, 'v1', 'release one');
  H.commit(repo, gpg, 'tail 1', { 'a.txt': 'two\n' });
  H.commit(repo, gpg, 'tail 2', { 'a.txt': 'three\n' });
  H.tagSigned(repo, gpg, 'v2', 'release two');

  const map = path.join(H.freshDir(label + '-map'), label + '-map.txt');
  const r = H.runBin('ght-squash', ['apply', repo, '--map', map, '--name=ac37', '--apply'], { gnupgHome: gpg.gnupgHome });
  T.exit(label + ': apply --apply over both pre-tagged releases: exit 0', r, 0);
  if (r.missing) return null;
  const s1 = H.revParse(repo, gpg, 'v1^{commit}');
  const s2 = H.revParse(repo, gpg, 'v2^{commit}');
  return [
    { tree: H.treeOf(repo, gpg, s1), date: identDate(repo, gpg, s1, 'author'), subject: subjectOf(repo, gpg, s1) },
    { tree: H.treeOf(repo, gpg, s2), date: identDate(repo, gpg, s2, 'author'), subject: subjectOf(repo, gpg, s2) },
  ];
}

/* Repo B: the same two releases, but each one finished with its own
 * `tail --tag` call as soon as its commits exist -- no tag exists before
 * `tail --tag` creates it. */
function buildTailPerRelease(label, gpg) {
  const repo = H.initRepo(label, gpg);
  H.commit(repo, gpg, 'root', { 'a.txt': 'one\n' });
  const r1 = H.runBin('ght-squash', ['tail', repo, '--tag=v1', '--message=release one', '--name=ac37', '--apply'], { gnupgHome: gpg.gnupgHome });
  T.exit(label + ': tail --tag=v1 (release one): exit 0', r1, 0);
  if (r1.missing) return null;

  H.commit(repo, gpg, 'tail 1', { 'a.txt': 'two\n' });
  H.commit(repo, gpg, 'tail 2', { 'a.txt': 'three\n' });
  const r2 = H.runBin('ght-squash', ['tail', repo, '--tag=v2', '--message=release two', '--name=ac37', '--apply'], { gnupgHome: gpg.gnupgHome });
  T.exit(label + ': tail --tag=v2 (release two): exit 0', r2, 0);
  if (r2.missing) return null;

  const s1 = H.revParse(repo, gpg, 'v1^{commit}');
  const s2 = H.revParse(repo, gpg, 'v2^{commit}');
  return [
    { tree: H.treeOf(repo, gpg, s1), date: identDate(repo, gpg, s1, 'author'), subject: subjectOf(repo, gpg, s1) },
    { tree: H.treeOf(repo, gpg, s2), date: identDate(repo, gpg, s2, 'author'), subject: subjectOf(repo, gpg, s2) },
  ];
}

const gpg = H.setupGpg('ac37');
if (gpg) {
  const rowsA = buildApplyAll('ac37-a', gpg);
  const rowsB = buildTailPerRelease('ac37-b', gpg);

  if (rowsA && rowsB) {
    T.eq('AC-37: one `apply` over both pre-tagged releases produces the exact same ' +
      'trees/dates/subjects, commit by commit, as `tail --tag` run once per release',
      rowsKey(rowsB), rowsKey(rowsA));
  }
}

T.finish();
