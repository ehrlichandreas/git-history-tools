/* AC-55 -- HIGH fix (reviewer-found, task 01a14ca4): `resign-commits`
 * used to move each affected ref (branch via `update-ref`, signed tag via
 * `tag -f -s` which both creates the object AND moves the ref in one
 * step) sequentially. A failure partway through (the Nth tag's signing,
 * say) left every ref processed so far already moved, and everything
 * after it untouched -- a half-rewritten repo.
 *
 * The fix, current form: every new tag object is built by
 * `buildSignedTagObject` (lib/sign.ts) -- the tag's raw text assembled by
 * hand, signed DETACHED via the same `--faked-system-time` gpg wrapper
 * `createSigner` already builds, written straight to the object store
 * via `git hash-object -t tag -w --stdin` -- which, like `commit-tree`
 * for a commit, never creates or moves ANY ref. No ref is touched until
 * the one closing `update-ref --stdin` transaction below. (Two earlier
 * attempts -- a throwaway temp tag name, and creating the object under
 * its REAL name via `git tag -f -s` then reverting the incidental ref
 * move it causes -- both have their own problems: see D14 for why
 * neither is this test's own fix. The second one in particular is NOT
 * actually atomic on its own terms, Lead-found: a crash between the
 * create and the revert leaves exactly one ref moved, which is the
 * injected-failure scenario below, generalised to a real crash instead
 * of a controlled refusal.)
 *
 * Only once every object this command needs already exists does it move
 * every branch and tag together in ONE `update-ref --stdin` transaction.
 * A failure building any object (this test forces one on the SECOND of
 * two tags, via a pre-existing `refs/tags/<name>.lock` file -- the same
 * lock git's own ref-update machinery uses, so the transaction's own
 * `prepare` phase refuses with "cannot lock ref", a reliable,
 * deterministic stand-in for a real signing failure) means the
 * transaction never runs at all -- nothing moves, not even the first tag
 * or any branch, `git for-each-ref` is byte-identical to before the
 * attempt (every ref, not just the ones this run would have touched),
 * and the backup bundle taken before any of this started is still
 * there. */
import fs from 'node:fs';
import path from 'node:path';
import * as H from '../lib/harness.ts';
const T = H.T;

H.requireBin('git-sign');

{
  const gpg = H.setupGpg('ac55-atomic');
  if (gpg) {
    const repo = H.initRepo('ac55-atomic', gpg);
    const git = H.gitIn(repo, gpg);

    const c0 = H.commit(repo, gpg, 'root', { 'a.txt': 'one\n' }, { date: '@1000000000 +0000' }).sha!;
    const c1 = H.commit(repo, gpg, 'second', { 'b.txt': 'two\n' }, { date: '@1000000100 +0000' }).sha!;
    H.tagSigned(repo, gpg, 'v-first'); // on c1, processed first (affectedTags order follows for-each-ref's own sort, alphabetical)
    H.tagSigned(repo, gpg, 'v-second'); // on c1 too, processed second

    const mainBefore = H.revParse(repo, gpg, 'refs/heads/main');
    const vFirstBefore = H.gitRaw(repo, gpg, ['rev-parse', 'refs/tags/v-first']).trim();
    const vSecondBefore = H.gitRaw(repo, gpg, ['rev-parse', 'refs/tags/v-second']).trim();
    /* The literal ask: a full `for-each-ref` snapshot (every ref, not
     * just the three this test happens to name above) must be
     * byte-identical after a failed attempt -- catching a ref this
     * fixture doesn't otherwise check for (there are none in this
     * fixture, by construction, but the snapshot comparison itself is
     * what proves that rather than assuming it). */
    const refsBefore = git(['for-each-ref']).stdout;

    /* Force the SECOND tag's object-creation step to fail: pre-create the
     * exact lock file git's own ref-update machinery uses for
     * `refs/tags/v-second` (as if another process were already mid-update
     * on it) -- `git tag -f -s v-second ...` then refuses with "cannot
     * lock ref ... File exists", a reliable, deterministic stand-in for a
     * real signing failure, exercised through the very same code path a
     * real gpg failure would hit. */
    const lockPath = path.join(repo, '.git', 'refs', 'tags', 'v-second.lock');
    fs.writeFileSync(lockPath, '');
    T.check('fixture: lock file created', fs.existsSync(lockPath));

    const policy = H.writePolicy('ac55-atomic', { signingKey: gpg.fingerprint, timezone: 'UTC' });
    const range = c0 + '..' + c1;

    const out = H.runBin('git-sign', ['resign-commits', repo, range, '--apply', '--policy=' + policy], { gnupgHome: gpg.gnupgHome });
    T.exit('AC-55: a failure building the second tag object is a refusal, exit 1', out, 1);
    T.contains('AC-55: names the tag that failed', out.stderr, 'v-second');

    T.eq('AC-55: main branch UNCHANGED (nothing moved, not even the branch)', H.revParse(repo, gpg, 'refs/heads/main'), mainBefore);
    T.eq('AC-55: v-first UNCHANGED (processed first, but the transaction never ran)',
      H.gitRaw(repo, gpg, ['rev-parse', 'refs/tags/v-first']).trim(), vFirstBefore);
    T.eq('AC-55: v-second UNCHANGED', H.gitRaw(repo, gpg, ['rev-parse', 'refs/tags/v-second']).trim(), vSecondBefore);
    T.eq('AC-55: git for-each-ref is byte-identical to before the attempt', git(['for-each-ref']).stdout, refsBefore);
    T.check('AC-55: the backup bundle taken before the attempt is still there', H.findBackupBundle(repo) !== null);

    /* Clean up the lock and confirm the SAME command now succeeds
     * cleanly, proving the refusal above was specific to the injected
     * lock collision, not some other defect. */
    fs.unlinkSync(lockPath);
    const retry = H.runBin('git-sign', ['resign-commits', repo, range, '--apply', '--policy=' + policy], { gnupgHome: gpg.gnupgHome });
    T.exit('AC-55: retrying after removing the collision succeeds', retry, 0);
    T.check('AC-55: main branch moved on the successful retry', H.revParse(repo, gpg, 'refs/heads/main') !== mainBefore);
  }
}

T.finish();
