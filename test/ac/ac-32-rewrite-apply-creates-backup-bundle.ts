/* AC-32 -- § 4.1 applied to git-history-rewrite: `replace --apply` creates
 * the backup bundle before touching any ref, same mechanics as
 * git-release-squash's own (AC-09) -- including the same order requirement:
 * the bundle must carry the PRE-rewrite branch tip and tag, not the
 * rewritten ones a bundle taken too late would show instead. */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as H from '../lib/harness.ts';
const T = H.T;

H.requireBin('git-history-rewrite');

const gpg = H.setupGpg('ac32');
if (gpg) {
  const repo = H.initRepo('ac32', gpg);
  H.commit(repo, gpg, 'add leak', { 'a.txt': 'jdoe@internal.example\n' });
  H.tagSigned(repo, gpg, 'v1', 'release v1');

  const branch = H.branchName(repo, gpg);
  const headBefore = H.revParse(repo, gpg, 'HEAD');
  const v1Before = H.revParse(repo, gpg, 'v1');

  const rulesFile = path.join(H.freshDir("ac32-rules"), "ac32-rules.txt");
  fs.writeFileSync(rulesFile, 'jdoe@internal.example\tREDACTED\n');

  const r = H.runBin('git-history-rewrite', ['replace', repo, '--rules', rulesFile, '--apply'], { gnupgHome: gpg.gnupgHome });
  T.exit('AC-32 replace --apply: exit 0', r, 0);
  if (!r.missing) {
    const base = path.basename(repo);
    const dir = path.dirname(repo);
    const entries = fs.readdirSync(dir).filter(n => n.startsWith(base + '.backup-') && n.endsWith('.bundle'));
    T.check('AC-32: exactly one backup bundle created', entries.length === 1, JSON.stringify(fs.readdirSync(dir)));
    if (entries.length === 1) {
      const bundlePath = path.join(dir, entries[0]);
      const verify = spawnSync('git', ['bundle', 'verify', bundlePath], { encoding: 'utf8', cwd: repo });
      T.check('AC-32: the bundle verifies cleanly', verify.status === 0, verify.stderr);

      const heads = H.bundleListHeads(bundlePath);
      T.eq('AC-32: the bundle\'s branch head is the PRE-rewrite commit (bundled before the rewrite, not after)',
        heads['refs/heads/' + branch], headBefore);
      T.eq('AC-32: the bundle\'s v1 is the PRE-rewrite tag object (not the rewritten one)',
        heads['refs/tags/v1'], v1Before);

      const headAfter = H.revParse(repo, gpg, 'HEAD');
      T.check('AC-32 sanity: replace actually rewrote the leaking commit', headAfter !== headBefore, headAfter);
    }
  }
}

T.finish();
