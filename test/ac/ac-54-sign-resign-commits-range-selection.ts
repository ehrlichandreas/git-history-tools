/* AC-54 -- CRITICAL fix (reviewer-found, task 01a14ca4): `resign-commits`
 * selected its rewrite set via `rev-list --branches --tags ^lower` alone,
 * which means "everything NOT an ancestor of lower" -- not "every
 * descendant of lower". That silently catches commits with NO relation
 * to <range> at all: an orphan branch with unrelated history, or a side
 * branch forked AT (or before) <lower> that never passes through any
 * commit in the range. Both are "not an ancestor of lower" (so the old
 * `^lower` filter let them through) while genuinely having nothing to do
 * with the rewrite.
 *
 * The fix: R0 = `rev-list lower..upper` (the literal range). Walk the
 * candidate superset (`--branches --tags ^lower`, still needed to catch
 * real descendants on OTHER branches) in topological order; a candidate
 * is rewritten only if it's in R0, or at least one of its real parents
 * was already marked for rewrite -- true transitive descendance from R0,
 * never mere non-ancestry of <lower>.
 *
 * Fixture: main carries the range (c0 lower/excluded, c1, c2 upper, c3
 * beyond upper); a side branch forked AT c0 (NOT in R0, parent c0 never
 * rewritten -- must stay untouched); a side branch forked at upper's own
 * parent c1 (c1 IS in R0 -- must be rewritten, a true descendant); an
 * orphan branch with its own unrelated root (must stay untouched); one
 * signed tag on each side/orphan tip, to check tags the same way. */
import * as H from '../lib/harness.ts';
const T = H.T;

H.requireBin('git-sign');

{
  const gpg = H.setupGpg('ac54-selection');
  if (gpg) {
    const repo = H.initRepo('ac54-selection', gpg);
    const git = H.gitIn(repo, gpg);

    const c0 = H.commit(repo, gpg, 'root (lower, excluded)', { 'a.txt': 'one\n' }, { date: '@1000000000 +0000' }).sha!;
    const c1 = H.commit(repo, gpg, 'second (in range)', { 'b.txt': 'two\n' }, { date: '@1000000100 +0000' }).sha!;
    const c2 = H.commit(repo, gpg, 'third (upper)', { 'c.txt': 'three\n' }, { date: '@1000000200 +0000' }).sha!;
    const c3 = H.commit(repo, gpg, 'fourth (beyond upper)', { 'd.txt': 'four\n' }, { date: '@1000000300 +0000' }).sha!;

    git(['checkout', '-q', '-b', 'side-from-lower', c0]);
    const sA = H.commit(repo, gpg, 'side branch forked AT lower -- unaffected', { 'sa.txt': 'x\n' }, { date: '@1000000400 +0000' }).sha!;
    H.tagSigned(repo, gpg, 'v-on-side-from-lower');

    git(['checkout', '-q', '-b', 'side-from-upper-parent', c1]);
    const sB = H.commit(repo, gpg, 'side branch forked at upper\'s own parent -- affected', { 'sb.txt': 'y\n' }, { date: '@1000000500 +0000' }).sha!;
    H.tagSigned(repo, gpg, 'v-on-side-from-upper-parent');

    git(['checkout', '-q', '--orphan', 'orphan']);
    const orphanRoot = H.commit(repo, gpg, 'orphan root, unrelated history -- unaffected', { 'o.txt': 'z\n' }, { date: '@1000000600 +0000' }).sha!;
    H.tagSigned(repo, gpg, 'v-on-orphan');
    T.check('fixture: the orphan commit really has no parent',
      H.gitRaw(repo, gpg, ['cat-file', 'commit', orphanRoot]).indexOf('\nparent ') === -1);

    git(['checkout', '-q', 'main']);

    const sideFromLowerTagObjBefore = H.gitRaw(repo, gpg, ['rev-parse', 'refs/tags/v-on-side-from-lower']).trim();
    const orphanTagObjBefore = H.gitRaw(repo, gpg, ['rev-parse', 'refs/tags/v-on-orphan']).trim();
    const sideFromUpperParentTagObjBefore = H.gitRaw(repo, gpg, ['rev-parse', 'refs/tags/v-on-side-from-upper-parent']).trim();

    const policy = H.writePolicy('ac54-selection', { signingKey: gpg.fingerprint, timezone: 'UTC' });
    const range = c0 + '..' + c2;

    const dry = H.runBin('git-sign', ['resign-commits', repo, range, '--policy=' + policy], { gnupgHome: gpg.gnupgHome });
    T.exit('AC-54: dry run exit 0', dry, 0);
    for (const c of [c1, c2, c3, sB]) {
      T.contains('AC-54: dry run lists ' + c.slice(0, 7) + ' as to-be-resigned (true descendant of R0)', dry.stdout, c.slice(0, 7) + ' would be re-signed');
    }
    for (const c of [c0, sA, orphanRoot]) {
      T.check('AC-54: dry run does NOT list ' + c.slice(0, 7) + ' (unrelated to the range)',
        !dry.stdout.includes(c.slice(0, 7) + ' would be re-signed'), dry.stdout);
    }
    T.contains('AC-54: dry run says main would move', dry.stdout, 'branch main would move');
    T.contains('AC-54: dry run says side-from-upper-parent would move', dry.stdout, 'branch side-from-upper-parent would move');
    T.check('AC-54: dry run does NOT say side-from-lower would move', !dry.stdout.includes('branch side-from-lower would move'), dry.stdout);
    T.check('AC-54: dry run does NOT say orphan would move', !dry.stdout.includes('branch orphan would move'), dry.stdout);
    T.contains('AC-54: dry run says the affected tag would move', dry.stdout, 'tag v-on-side-from-upper-parent would be re-signed and moved');
    T.check('AC-54: dry run does NOT mention the unaffected side tag', !dry.stdout.includes('v-on-side-from-lower would'), dry.stdout);
    T.check('AC-54: dry run does NOT mention the unaffected orphan tag', !dry.stdout.includes('v-on-orphan would'), dry.stdout);

    const out = H.runBin('git-sign', ['resign-commits', repo, range, '--apply', '--policy=' + policy], { gnupgHome: gpg.gnupgHome });
    T.exit('AC-54: apply exit 0', out, 0);

    T.eq('AC-54: side-from-lower branch UNCHANGED', H.revParse(repo, gpg, 'refs/heads/side-from-lower'), sA);
    T.eq('AC-54: orphan branch UNCHANGED', H.revParse(repo, gpg, 'refs/heads/orphan'), orphanRoot);
    T.eq('AC-54: v-on-side-from-lower tag object UNCHANGED (exact original)',
      H.gitRaw(repo, gpg, ['rev-parse', 'refs/tags/v-on-side-from-lower']).trim(), sideFromLowerTagObjBefore);
    T.eq('AC-54: v-on-orphan tag object UNCHANGED (exact original)',
      H.gitRaw(repo, gpg, ['rev-parse', 'refs/tags/v-on-orphan']).trim(), orphanTagObjBefore);

    T.check('AC-54: main branch MOVED (true descendant chain was rewritten)', H.revParse(repo, gpg, 'refs/heads/main') !== c3);
    T.check('AC-54: side-from-upper-parent branch MOVED', H.revParse(repo, gpg, 'refs/heads/side-from-upper-parent') !== sB);
    T.check('AC-54: v-on-side-from-upper-parent tag object MOVED',
      H.gitRaw(repo, gpg, ['rev-parse', 'refs/tags/v-on-side-from-upper-parent']).trim() !== sideFromUpperParentTagObjBefore);
  }
}

T.finish();
