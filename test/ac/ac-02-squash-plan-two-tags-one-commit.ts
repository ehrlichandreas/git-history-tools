/* AC-02 -- § 1.1: two tags pointing at the same commit are both printed,
 * adjacent, each with its own fold-count/tree-equality pair. Also § 1.2
 * (D2 item 4): `apply --apply` re-points BOTH tags at the very same new
 * squash commit (one commit, two tags on it, same as the source) -- its
 * subject names whichever tag plan listed first for that commit. */
import path from 'node:path';
import * as H from '../lib/harness.ts';
const T = H.T;

H.requireBin('git-release-squash');

const gpg = H.setupGpg('ac02');
if (gpg) {
  const repo = H.initRepo('ac02', gpg);
  H.commit(repo, gpg, 'root', { 'a.txt': 'one\n' });
  const c2 = H.commit(repo, gpg, 'second', { 'a.txt': 'two\n' });
  H.tagSigned(repo, gpg, 'v1.0', 'first release name');
  H.tagSigned(repo, gpg, 'v1.0.1', 'same tree, second tag name');

  const r = H.runBin('git-release-squash', ['plan', repo], { gnupgHome: gpg.gnupgHome });
  T.exit('AC-02 plan: exit 0', r, 0);
  if (!r.missing) {
    T.contains('AC-02: v1.0 reported', r.stdout, 'plan: v1.0 folds');
    T.contains('AC-02: v1.0.1 reported too (same commit, different tag)', r.stdout, 'plan: v1.0.1 folds');
    T.contains('AC-02: v1.0 tree-equality OK', r.stdout, 'plan: v1.0 tree equals');
    T.contains('AC-02: v1.0.1 tree-equality OK', r.stdout, 'plan: v1.0.1 tree equals');

    const lines = r.stdout.split('\n').filter(Boolean);
    const iv1 = lines.findIndex(l => l.startsWith('plan: v1.0 folds'));
    const iv1ok = lines.findIndex(l => l.startsWith('plan: v1.0 tree'));
    const iv101 = lines.findIndex(l => l.startsWith('plan: v1.0.1 folds'));
    T.check('AC-02: v1.0\'s own pair of lines is adjacent (folds, then tree-equality)',
      iv1 >= 0 && iv1ok === iv1 + 1, JSON.stringify(lines));
    T.check('AC-02: v1.0.1\'s pair comes right after v1.0\'s pair, not interleaved',
      iv101 === iv1ok + 1, JSON.stringify(lines));

    T.check('AC-02: each tag folds exactly 1 commit (the commit itself, nothing re-counted across tags)',
      /plan: v1\.0 folds 1 commit\(s\)/.test(r.stdout) && /plan: v1\.0\.1 folds 1 commit\(s\)/.test(r.stdout),
      r.stdout);
  }

  const map = path.join(H.freshDir("ac02-map"), "ac02-map.txt");
  const applied = H.runBin('git-release-squash', ['apply', repo, '--map', map, '--apply'], { gnupgHome: gpg.gnupgHome });
  T.exit('AC-02 apply --apply: exit 0', applied, 0);
  if (!applied.missing) {
    const sha1 = H.revParse(repo, gpg, 'v1.0^{commit}');
    const sha2 = H.revParse(repo, gpg, 'v1.0.1^{commit}');
    T.eq('AC-02 apply: v1.0 and v1.0.1 point at the SAME new squash commit (they folded the same source commit)',
      sha2, sha1);
    const raw = H.catFile(repo, gpg, sha1, '-p');
    T.contains('AC-02 apply: the shared commit\'s subject names v1.0 (plan\'s first-listed tag for this commit)',
      raw, 'v1.0: first release name');
    T.check('AC-02 apply: the subject does NOT also/instead name v1.0.1',
      !raw.includes('v1.0.1:'), raw);

    const log = H.log(repo, gpg, ['--oneline']);
    T.eq('AC-02 apply: history is exactly 1 commit (both tags fold into the one squash commit, not two)',
      log.split('\n').filter(Boolean).length, 1);
  }
}

T.finish();
