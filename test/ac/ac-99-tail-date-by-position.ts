/* AC-99 -- § 4.3 (D23): the commit `tail` writes gets the anon date for
 * its position in the resulting history, which is the parent's position
 * plus one. `tail` took the number of tagged commits instead, so with an
 * untagged commit before the last tag (an unsquashed prefix) the date
 * came out one day per such commit too early: here `first`, `second` (v1),
 * then the tail, gave 1970-01-03, the slot of `second` itself, where
 * § 4.3 says 1970-01-04. Every commit tagged (the shape `apply` leaves)
 * was right before and stays right; no tag at all is the root, 01-02. */
import * as H from '../lib/harness.ts';
const T = H.T;

H.requireBin('git-release-squash');

const anon = (i: number) => ((i + 1) * 86400 + 43200) + ' +0000';
const identDate = (raw: string, field: string) => {
  const m = new RegExp('^' + field + ' .* (\\d+ [+-]\\d{4})$', 'm').exec(raw);
  return m ? m[1] : null;
};

const CASES: [string, string[], number][] = [
  ['an untagged commit before v1', ['first', 'second:v1'], 2],
  ['two untagged commits before v1', ['first', 'second', 'third:v1'], 3],
  ['every commit tagged', ['first:v0', 'second:v1'], 2],
  ['no tag at all', [], 0],
];

for (const [label, prefix, position] of CASES) {
  for (const withTag of [false, true]) {
    const gpg = H.setupGpg('ac92');
    if (!gpg) continue;
    const repo = H.initRepo('ac92', gpg);
    let n = 0;
    for (const p of prefix) {
      const [msg, tag] = p.split(':');
      H.commit(repo, gpg, msg, { 'a.txt': msg + '\n' }, { date: '2020-01-0' + (++n) + 'T10:00:00 +0000' });
      if (tag) H.tagSigned(repo, gpg, tag, 'release ' + tag);
    }
    H.commit(repo, gpg, 'tail one', { 'a.txt': 'tail one\n' }, { date: '2020-02-01T10:00:00 +0000' });
    H.commit(repo, gpg, 'tail two', { 'a.txt': 'tail two\n' }, { date: '2020-02-02T10:00:00 +0000' });
    const parentBefore = prefix.length > 0 ? H.revParse(repo, gpg, 'HEAD~2') : null;
    const l = 'AC-99 [' + label + (withTag ? ', --tag' : '') + ']';

    const args = ['tail', repo, '--apply'];
    if (withTag) args.push('--tag=v9', '--message=release nine');
    const r = H.runBin('git-release-squash', args, { gnupgHome: gpg.gnupgHome });
    T.exit(l + ': exit 0', r, 0);
    if (r.status !== 0) continue;
    const raw = H.catFile(repo, gpg, 'HEAD', '-p');
    T.eq(l + ': author date is the anon date for position ' + position, identDate(raw, 'author'), anon(position));
    T.eq(l + ': committer date is the anon date for position ' + position, identDate(raw, 'committer'), anon(position));
    if (parentBefore === null) T.eq(l + ': no tag, so the new commit is the root', H.gitRaw(repo, gpg, ['rev-list', '--count', 'HEAD']).trim(), '1');
    else T.eq(l + ': the parent is the last tagged commit, unchanged', H.revParse(repo, gpg, 'HEAD^'), parentBefore);
    if (withTag) T.eq(l + ': the tagger date is the commit date', identDate(H.catFile(repo, gpg, 'v9', '-p'), 'tagger'), anon(position));
  }
}

T.finish();
