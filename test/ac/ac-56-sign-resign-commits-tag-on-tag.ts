/* AC-56 -- MEDIUM fix (reviewer-found, task 01a14ca4): an outer signed tag
 * whose IMMEDIATE target is another tag (tag-on-tag), not a commit
 * directly, used to get flattened by `resign-commits` -- the outer tag
 * was recreated pointing straight at the new commit, silently dropping
 * the inner tag from the chain.
 *
 * The fix: the outer tag is resigned only once its inner tag's own new
 * object exists, and is recreated pointing AT that new inner tag object,
 * with the same `type tag` header -- never flattened onto the commit.
 * This also doubles as the regression check for the HIGH-fix rework
 * (AC-55/AC-46): the new tag object is created under its REAL name (a
 * throwaway temp name was tried first and rejected, since a tag object's
 * `tag <name>` header is baked into its own content, not a ref pointer),
 * so both the inner and outer tag's own `tag <name>` header must come out
 * correct too, not some temp name. */
import * as H from '../lib/harness.ts';
const T = H.T;

H.requireBin('git-sign');

{
  const gpg = H.setupGpg('ac56-tag-on-tag');
  if (gpg) {
    const repo = H.initRepo('ac56-tag-on-tag', gpg);
    const git = H.gitIn(repo, gpg);

    const c0 = H.commit(repo, gpg, 'root (lower, excluded)', { 'a.txt': 'one\n' }, { date: '@1000000000 +0000' }).sha!;
    const c1 = H.commit(repo, gpg, 'second (upper, in range)', { 'b.txt': 'two\n' }, { date: '@1000000100 +0000' }).sha!;

    H.tagSigned(repo, gpg, 'v-inner', 'inner tag, directly on a commit');
    const innerObjBefore = H.gitRaw(repo, gpg, ['rev-parse', 'refs/tags/v-inner']).trim();
    const outerMade = git(['tag', '-s', 'v-outer', 'v-inner', '-m', 'outer tag, points at the inner tag']);
    T.check('fixture: outer tag created on top of the inner tag', outerMade.status === 0, outerMade.stderr);
    const outerObjBefore = H.gitRaw(repo, gpg, ['rev-parse', 'refs/tags/v-outer']).trim();
    T.check('fixture: outer tag\'s own immediate target really is the inner tag object (not a commit)',
      H.gitRaw(repo, gpg, ['cat-file', '-p', outerObjBefore]).includes('type tag\n'));

    const policy = H.writePolicy('ac56-tag-on-tag', { signingKey: gpg.fingerprint, timezone: 'UTC' });
    const range = c0 + '..' + c1;

    const out = H.runBin('git-sign', ['resign-commits', repo, range, '--apply', '--policy=' + policy], { gnupgHome: gpg.gnupgHome });
    T.exit('AC-56: apply exit 0', out, 0);

    const innerObjAfter = H.gitRaw(repo, gpg, ['rev-parse', 'refs/tags/v-inner']).trim();
    const outerObjAfter = H.gitRaw(repo, gpg, ['rev-parse', 'refs/tags/v-outer']).trim();
    T.check('AC-56: inner tag object MOVED (its commit target was re-signed)', innerObjAfter !== innerObjBefore);
    T.check('AC-56: outer tag object MOVED too (chained through the inner tag)', outerObjAfter !== outerObjBefore);

    const outerRaw = H.gitRaw(repo, gpg, ['cat-file', '-p', outerObjAfter]);
    T.contains('AC-56: outer tag is NOT flattened onto the commit -- still type tag', outerRaw, 'type tag\n');
    T.contains('AC-56: outer tag object header still carries ITS OWN real name',
      outerRaw, '\ntag v-outer\n');
    T.contains('AC-56: outer tag\'s object field points at the NEW inner tag object, not the commit',
      outerRaw, 'object ' + innerObjAfter + '\n');

    const innerRaw = H.gitRaw(repo, gpg, ['cat-file', '-p', innerObjAfter]);
    T.contains('AC-56: inner tag object header still carries ITS OWN real name (not some temp name)',
      innerRaw, '\ntag v-inner\n');

    T.check('AC-56: inner tag verifies', git(['tag', '-v', 'v-inner']).status === 0);
    T.check('AC-56: outer tag verifies', git(['tag', '-v', 'v-outer']).status === 0);
  }
}

T.finish();
