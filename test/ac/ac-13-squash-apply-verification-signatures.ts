/* AC-13 -- § 4.2 check 2: post-rewrite verification confirms every commit
 * and annotated tag reachable from any ref carries a signature
 * `git verify-commit`/`git verify-tag` accepts, and the tool prints that
 * check's OK line. */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
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

/* Bug fix regression: verifySignatures() used to walk `rev-list --all`,
 * which also follows refs/remotes/* (and refs/stash, refs/notes) -- a
 * stale remote-tracking ref left pointing at the pre-squash tip (apply
 * never touches refs/remotes) made an old, now-superseded commit still
 * show up as "reachable" and get checked, even though it carries a
 * signature from a totally different key than the one actually used for
 * the squash. Reproduced here: the root commit (which gets squashed away)
 * is signed with a SEPARATE throwaway key the squash's own keyring never
 * sees, and a `refs/remotes/origin/main` ref is left pointing at it --
 * `apply --apply` must still report `verify: signatures: OK` and never
 * mention that commit or its key at all. */
{
  const gpgA = H.setupGpg('ac13-a');
  const gpgB = H.setupGpg('ac13-b');
  if (gpgA && gpgB) {
    const repo = H.initRepo('ac13-cross-key', gpgA);

    /* Root commit signed with key B (repo's configured signingkey is A,
     * from initRepo -- override it just for this one commit so it's
     * genuinely B-signed, not A-signed). */
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
    const gitB = H.gitIn(repo, gpgB);
    gitB(['add', '-A']);
    const commitB = gitB(['-c', 'user.signingkey=' + gpgB.fingerprint, 'commit', '-q', '-S', '-m', 'root']);
    T.check('AC-13 (cross-key) fixture: root commit signed with key B', commitB.status === 0, commitB.stderr);
    const rootSha = H.revParse(repo, gpgA, 'HEAD');

    H.tagSigned(repo, gpgA, 'v1', 'release v1');

    /* Simulate a remote clone's stale tracking ref: still at the
     * pre-squash tip, since apply never fetches or pushes. */
    H.gitRaw(repo, gpgA, ['update-ref', 'refs/remotes/origin/main', rootSha]);

    const map = path.join(H.freshDir("ac13-cross-key-map"), "ac13-cross-key-map.txt");
    const r = H.runBin('git-release-squash', ['apply', repo, '--map', map, '--apply'], { gnupgHome: gpgA.gnupgHome });
    T.exit('AC-13 (cross-key): apply --apply: exit 0', r, 0);
    if (!r.missing) {
      T.contains('AC-13 (cross-key): signatures check is OK, not referencing the orphaned key-B commit',
        r.stdout, 'verify: signatures: OK');
      T.check('AC-13 (cross-key): stdout/stderr never mention the old root commit\'s sha',
        !r.stdout.includes(rootSha.slice(0, 7)) && !r.stderr.includes(rootSha.slice(0, 7)),
        'stdout: ' + r.stdout + ' stderr: ' + r.stderr);
    }
  }
}

T.finish();
