/* AC-13 -- § 4.2 check 2: post-rewrite verification confirms every commit
 * and annotated tag reachable from any ref carries a signature
 * `git verify-commit`/`git verify-tag` accepts, and the tool prints that
 * check's OK line. */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import * as H from '../lib/harness.ts';
const T = H.T;

H.requireBin('git-release-squash');

const gpg = H.setupGpg('ac13');
if (gpg) {
  const repo = H.initRepo('ac13', gpg);
  H.commit(repo, gpg, 'root', { 'a.txt': 'one\n' });
  H.tagSigned(repo, gpg, 'v1', 'release v1');
  H.commit(repo, gpg, 'second', { 'a.txt': 'two\n' });
  H.tagSigned(repo, gpg, 'v2', 'release v2');

  const map = path.join(H.freshDir("ac13-map"), "ac13-map.txt");
  const r = H.runBin('git-release-squash', ['apply', repo, '--map', map, '--apply'], { gnupgHome: gpg.gnupgHome });
  T.exit('AC-13 apply --apply: exit 0', r, 0);
  if (!r.missing) {
    T.contains('AC-13: the signatures check reports OK', r.stdout, 'verify: signatures: OK');

    /* v1/v2 are annotated tags -- verify-commit takes a commit, not a tag
     * object, so peel each to its own commit first. */
    const v1 = H.revParse(repo, gpg, 'v1^{commit}');
    const v2 = H.revParse(repo, gpg, 'v2^{commit}');
    const vc1 = spawnSync('git', ['verify-commit', v1], { cwd: repo, env: gpg.env, encoding: 'utf8' });
    const vc2 = spawnSync('git', ['verify-commit', v2], { cwd: repo, env: gpg.env, encoding: 'utf8' });
    T.check('AC-13: git verify-commit genuinely accepts the new v1 commit', vc1.status === 0, vc1.stderr);
    T.check('AC-13: git verify-commit genuinely accepts the new v2 commit', vc2.status === 0, vc2.stderr);
    const vt1 = spawnSync('git', ['verify-tag', 'v1'], { cwd: repo, env: gpg.env, encoding: 'utf8' });
    const vt2 = spawnSync('git', ['verify-tag', 'v2'], { cwd: repo, env: gpg.env, encoding: 'utf8' });
    T.check('AC-13: git verify-tag genuinely accepts v1', vt1.status === 0, vt1.stderr);
    T.check('AC-13: git verify-tag genuinely accepts v2', vt2.status === 0, vt2.stderr);
  }
}

T.finish();
