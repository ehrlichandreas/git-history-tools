/* AC-72 -- D20: every tool names refs by their full refname. A branch and
 * a tag may share a name, and then `%(refname:short)` (and `symbolic-ref
 * --short`) disambiguate it as `heads/<x>` / `tags/<x>`; the tools
 * prefixed that again and moved `refs/heads/heads/<x>` or
 * `refs/tags/tags/<x>` -- new refs -- while the real ones stayed on the
 * old history. Each writing path is run on a repo where a branch and a
 * tag share a name; afterwards the set of refnames is unchanged, both
 * real refs moved, and verification passes. */
import fs from 'node:fs';
import path from 'node:path';
import * as H from '../lib/harness.ts';
const T = H.T;

H.requireBin('git-history-rewrite');
H.requireBin('git-release-squash');
H.requireBin('git-sign');

const outside = H.freshDir('ac72-files');
const rules = path.join(outside, 'rules.tsv');
fs.writeFileSync(rules, 'hello\tbye\n');

function refs(repo: string, gpg: H.Gpg): Record<string, string> {
  const out: Record<string, string> = {};
  for (const l of H.gitRaw(repo, gpg, ['for-each-ref', '--format=%(refname) %(objectname)']).split('\n')) {
    if (!l) continue;
    const [r, sha] = l.split(' ');
    out[r] = sha;
  }
  return out;
}
function checkMoved(label: string, before: Record<string, string>, after: Record<string, string>, moved: string[]) {
  T.eq(label + ': the same refnames as before, no doubled prefix', Object.keys(after).sort(), Object.keys(before).sort());
  for (const r of moved) T.check(label + ': ' + r + ' moved', after[r] !== undefined && after[r] !== before[r], before[r] + ' -> ' + after[r]);
}

/* replace: branch x and annotated tag x on the same commit; main has its own tip. */
{
  const gpg = H.setupGpg('ac72-rw');
  if (gpg) {
    const repo = H.initRepo('ac72-rw', gpg);
    const git = H.gitIn(repo, gpg);
    H.commit(repo, gpg, 'first', { 'a.txt': 'hello\n' });
    git(['branch', 'x']);
    H.tagSigned(repo, gpg, 'x', 'tag x');
    H.tagLightweight(repo, gpg, 'y');
    git(['branch', 'y']);
    H.commit(repo, gpg, 'second', { 'b.txt': 'hello again\n' });
    const before = refs(repo, gpg);
    const r = H.runBin('git-history-rewrite', ['replace', repo, '--rules', rules, '--apply'], { gnupgHome: gpg.gnupgHome });
    T.exit('AC-72 [replace]: exit 0', r, 0);
    checkMoved('AC-72 [replace]', before, refs(repo, gpg), ['refs/heads/main', 'refs/heads/x', 'refs/tags/x', 'refs/heads/y', 'refs/tags/y']);
    T.eq('AC-72 [replace]: branch x has the rewritten content', H.gitRaw(repo, gpg, ['show', 'refs/heads/x:a.txt']), 'bye\n');
    T.eq('AC-72 [replace]: tag x has the rewritten content', H.gitRaw(repo, gpg, ['show', 'refs/tags/x:a.txt']), 'bye\n');
  }
}

/* squash apply: HEAD is on a branch named like its own tag. */
{
  const gpg = H.setupGpg('ac72-apply');
  if (gpg) {
    const repo = H.initRepo('ac72-apply', gpg);
    const git = H.gitIn(repo, gpg);
    git(['checkout', '-q', '-b', 'v1']);
    H.commit(repo, gpg, 'first', { 'a.txt': 'one\n' });
    H.commit(repo, gpg, 'second', { 'a.txt': 'two\n' });
    H.tagSigned(repo, gpg, 'v1', 'release one');
    const before = refs(repo, gpg);
    const map = path.join(outside, 'apply-map.txt');
    const r = H.runBin('git-release-squash', ['apply', repo, '--map', map, '--apply'], { gnupgHome: gpg.gnupgHome });
    T.exit('AC-72 [apply]: exit 0', r, 0);
    T.contains('AC-72 [apply]: verify: squash: every commit tagged: OK', r.stdout, 'verify: squash: every commit tagged: OK');
    const after = refs(repo, gpg);
    checkMoved('AC-72 [apply]', before, after, ['refs/heads/v1', 'refs/tags/v1']);
    T.eq('AC-72 [apply]: tag v1 points at the new branch tip', H.revParse(repo, gpg, 'refs/tags/v1^{commit}'), after['refs/heads/v1']);
  }
}

/* tail: HEAD is on a branch named like an older tag. */
{
  const gpg = H.setupGpg('ac72-tail');
  if (gpg) {
    const repo = H.initRepo('ac72-tail', gpg);
    const git = H.gitIn(repo, gpg);
    git(['checkout', '-q', '-b', 'v1']);
    H.commit(repo, gpg, 'first', { 'a.txt': 'one\n' });
    H.tagSigned(repo, gpg, 'v1', 'release one');
    H.commit(repo, gpg, 'second', { 'a.txt': 'two\n' });
    H.commit(repo, gpg, 'third', { 'a.txt': 'three\n' });
    const before = refs(repo, gpg);
    const r = H.runBin('git-release-squash', ['tail', repo, '--apply'], { gnupgHome: gpg.gnupgHome });
    T.exit('AC-72 [tail]: exit 0', r, 0);
    const after = refs(repo, gpg);
    checkMoved('AC-72 [tail]', before, after, ['refs/heads/v1']);
    T.eq('AC-72 [tail]: the new tip is one commit on top of tag v1', H.revParse(repo, gpg, 'refs/heads/v1~1'), H.revParse(repo, gpg, 'refs/tags/v1^{commit}'));
  }
}

/* git-sign resign-tags and resign-commits: branch x and tag x on HEAD. */
for (const sub of ['resign-tags', 'resign-commits']) {
  const gpg = H.setupGpg('ac72-' + sub);
  if (!gpg) continue;
  const repo = H.initRepo('ac72-' + sub, gpg);
  const git = H.gitIn(repo, gpg);
  H.commit(repo, gpg, 'first', { 'a.txt': 'one\n' }, { date: '@1000000000 +0000' });
  H.commit(repo, gpg, 'second', { 'a.txt': 'two\n' }, { date: '@1000086400 +0000' });
  git(['branch', 'x']);
  H.tagSigned(repo, gpg, 'x', 'tag x');
  const before = refs(repo, gpg);
  const policy = H.writePolicy('ac72-' + sub, { signingKey: gpg.fingerprint });
  const args = sub === 'resign-tags' ? ['resign-tags', repo, 'x'] : ['resign-commits', repo, 'HEAD~1..HEAD'];
  const r = H.runBin('git-sign', args.concat(['--policy=' + policy, '--apply']), { gnupgHome: gpg.gnupgHome });
  T.exit('AC-72 [' + sub + ']: exit 0', r, 0);
  T.check('AC-72 [' + sub + ']: no verify line FAILED', !/FAILED/.test(r.stdout), r.stdout);
  const after = refs(repo, gpg);
  /* The key is minutes old, so every re-sign is pinned to its creation + 60 s,
   * a different signature time than the fixture's: each moved ref gets a new sha. */
  checkMoved('AC-72 [' + sub + ']', before, after, sub === 'resign-tags' ? ['refs/tags/x'] : ['refs/heads/main', 'refs/heads/x', 'refs/tags/x']);
  if (sub === 'resign-commits') {
    T.eq('AC-72 [resign-commits]: branch x follows main', after['refs/heads/x'], after['refs/heads/main']);
    T.eq('AC-72 [resign-commits]: tag x points at the new tip', H.revParse(repo, gpg, 'refs/tags/x^{commit}'), after['refs/heads/main']);
  }
}

T.finish();
