/* AC-59 -- two Lead-directed `resign-commits`/`resign-tags` requirements
 * found dogfooding against nanojira's real history (task 01a14ca4):
 *
 * (a) Root-inclusive range. `<lower>..<upper>` requires `lower` to
 * resolve to an EXISTING commit and is lower-exclusive by convention --
 * there is no commit before a history's own root to name as `lower`, so
 * there was previously no way to say "resign everything, root commit
 * included". A bare `<range>` with no `..` now means exactly that: every
 * ancestor of `<range>`, root included (mirrors `git rev-list <ref>`'s
 * own "no exclusion" meaning for a single revision) -- given together
 * with `--from-root` (D17; without it the bare form is a usage error,
 * AC-62).
 *
 * (b) "Replaced unverifiable signature" reporting. `resign-commits`/
 * `resign-tags` already unconditionally overwrite ANY existing signature
 * regardless of its own validity -- they never refused or crashed on one
 * they can't verify. What was missing is naming it: a signature made by a
 * key this keyring doesn't have (NO_PUBKEY) is silently replaced with no
 * record it ever differed. Fixture: a commit and a tag each signed by a
 * SEPARATE throwaway identity (its own GNUPGHOME, never imported into the
 * policy key's keyring) stand in for nanojira's real pre-326fc528 history,
 * signed by a key since dropped from the keyring entirely. */
import * as H from '../lib/harness.ts';
import { spawnSync } from 'node:child_process';
const T = H.T;

H.requireBin('git-sign');

/* -------------------------------------------------- (a) root range --- */
{
  const gpg = H.setupGpg('ac59-root-range');
  if (gpg) {
    const repo = H.initRepo('ac59-root-range', gpg);
    const c0 = H.commit(repo, gpg, 'root', { 'a.txt': 'one\n' }, { date: '@1000000000 +0000' }).sha!;
    const c1 = H.commit(repo, gpg, 'second', { 'b.txt': 'two\n' }, { date: '@1000000100 +0000' }).sha!;
    const c2 = H.commit(repo, gpg, 'third', { 'c.txt': 'three\n' }, { date: '@1000000200 +0000' }).sha!;
    T.check('fixture: root commit really has no parent', H.catFile(repo, gpg, c0, 'commit').indexOf('\nparent ') === -1);
    const origRootTree = H.treeOf(repo, gpg, c0);

    const policy = H.writePolicy('ac59-root-range', { signingKey: gpg.fingerprint, timezone: 'UTC' });

    const badRange = H.runBin('git-sign', ['resign-commits', repo, 'main...HEAD', '--policy=' + policy], { gnupgHome: gpg.gnupgHome });
    T.check('AC-59a: three-dot range still refused', badRange.status !== 0, badRange.stdout + badRange.stderr);

    const dry = H.runBin('git-sign', ['resign-commits', repo, 'main', '--from-root', '--policy=' + policy], { gnupgHome: gpg.gnupgHome });
    T.exit('AC-59a: dry run over a bare ref (no ..) exits 0', dry, 0);
    for (const c of [c0, c1, c2]) {
      T.contains('AC-59a: dry run lists ' + c.slice(0, 7) + ' (root-inclusive)', dry.stdout, c.slice(0, 7) + ' would be re-signed');
    }

    const apply = H.runBin('git-sign', ['resign-commits', repo, 'main', '--from-root', '--apply', '--policy=' + policy], { gnupgHome: gpg.gnupgHome });
    T.exit('AC-59a: apply over a bare ref exits 0', apply, 0);

    const newHead = H.revParse(repo, gpg, 'refs/heads/main');
    T.check('AC-59a: main moved', newHead !== c2);
    const newRoot = H.gitRaw(repo, gpg, ['rev-list', '--max-parents=0', newHead]).trim();
    T.check('AC-59a: new history still has exactly one root', newRoot.split('\n').length === 1 && newRoot !== '');
    T.check('AC-59a: new root has no parent either', H.catFile(repo, gpg, newRoot, 'commit').indexOf('\nparent ') === -1);
    T.eq('AC-59a: new root tree == old root tree', H.treeOf(repo, gpg, newRoot), origRootTree);
    const vc = H.gitIn(repo, gpg)(['verify-commit', newRoot]);
    T.check('AC-59a: git verify-commit accepts the re-signed root', vc.status === 0, vc.stderr);
    const vcHead = H.gitIn(repo, gpg)(['verify-commit', newHead]);
    T.check('AC-59a: git verify-commit accepts the re-signed HEAD', vcHead.status === 0, vcHead.stderr);
  }
}

/* --------------------------------------- (b) unverifiable signature --- */
{
  const gpg = H.setupGpg('ac59-unverif');
  const other = H.setupGpg('ac59-unverif-other');
  if (gpg && other) {
    const repo = H.initRepo('ac59-unverif', gpg);
    const c0 = H.commit(repo, gpg, 'root, signed by the policy key already', { 'a.txt': 'one\n' }, { date: '@1000000000 +0000' }).sha!;

    /* c1: signed by `other`'s key -- author/committer identity unchanged
     * (still the fixture's own user.name/email), only the signing key and
     * keyring differ, standing in for history signed by a key since
     * dropped from the keyring entirely (nanojira's real pre-326fc528
     * commits, old key E87870613F0E8704). */
    const otherEnv = Object.assign({}, gpg.env, { GNUPGHOME: other.gnupgHome });
    const r1 = spawnSync('git', ['-c', 'user.signingkey=' + other.fingerprint, '-c', 'gpg.program=gpg',
      'commit', '-q', '--allow-empty', '-S', '-m', 'second, signed by a since-dropped key'],
      { cwd: repo, env: Object.assign({}, otherEnv, { GIT_AUTHOR_DATE: '@1000000100 +0000', GIT_COMMITTER_DATE: '@1000000100 +0000' }), encoding: 'utf8' });
    T.check('fixture: c1 signed by the OTHER key', r1.status === 0, r1.stderr);
    const c1 = H.revParse(repo, gpg, 'HEAD');
    T.check('fixture: c1 is not verifiable under the policy keyring',
      H.gitIn(repo, gpg)(['verify-commit', c1]).status !== 0);

    /* Tagged at c0, not c1/HEAD -- c0 is the exclusive LOWER bound of the
     * resign-commits range below, so it stays untouched by that call;
     * tagging HEAD instead would mean resign-commits (c1 being in its own
     * rewrite set) already re-signs this same tag as a side effect of
     * moving c1, leaving nothing left for the resign-tags call below to
     * find -- not a bug, EdDSA signing is deterministic (same key +
     * message + time -> byte-identical signature), just the wrong fixture
     * for isolating the resign-TAGS path specifically. */
    const otagr = spawnSync('git', ['-c', 'user.signingkey=' + other.fingerprint, '-c', 'gpg.program=gpg',
      'tag', '-s', 'v-othersigned', '-m', 'tag signed by a since-dropped key', c0],
      { cwd: repo, env: otherEnv, encoding: 'utf8' });
    T.check('fixture: v-othersigned signed by the OTHER key', otagr.status === 0, otagr.stderr);

    const policy = H.writePolicy('ac59-unverif', { signingKey: gpg.fingerprint, timezone: 'UTC' });

    const dryCommits = H.runBin('git-sign', ['resign-commits', repo, c0 + '..' + c1, '--policy=' + policy], { gnupgHome: gpg.gnupgHome });
    T.exit('AC-59b: resign-commits dry run exits 0', dryCommits, 0);
    T.contains('AC-59b: dry run names the unverifiable key for c1', dryCommits.stdout,
      c1.slice(0, 7) + ' would replace unverifiable signature (key ');
    T.check('AC-59b: dry run does NOT flag c0 (already correctly signed)',
      !dryCommits.stdout.includes(c0.slice(0, 7) + ' would replace unverifiable signature'), dryCommits.stdout);

    const applyCommits = H.runBin('git-sign', ['resign-commits', repo, c0 + '..' + c1, '--apply', '--policy=' + policy], { gnupgHome: gpg.gnupgHome });
    T.exit('AC-59b: resign-commits apply exits 0', applyCommits, 0);
    T.contains('AC-59b: apply names the unverifiable key for c1', applyCommits.stdout,
      c1.slice(0, 7) + ' replaced unverifiable signature (key ');

    const dryTags = H.runBin('git-sign', ['resign-tags', repo, 'v-othersigned', '--policy=' + policy], { gnupgHome: gpg.gnupgHome });
    T.exit('AC-59b: resign-tags dry run exits 0', dryTags, 0);
    T.contains('AC-59b: dry run names the unverifiable key for the tag', dryTags.stdout,
      'v-othersigned would replace unverifiable signature (key ');

    const applyTags = H.runBin('git-sign', ['resign-tags', repo, 'v-othersigned', '--apply', '--policy=' + policy], { gnupgHome: gpg.gnupgHome });
    T.exit('AC-59b: resign-tags apply exits 0', applyTags, 0);
    T.contains('AC-59b: apply names the unverifiable key for the tag', applyTags.stdout,
      'v-othersigned replaced unverifiable signature (key ');
    const vtag = H.gitIn(repo, gpg)(['tag', '-v', 'v-othersigned']);
    T.check('AC-59b: v-othersigned now verifies under the policy key', vtag.status === 0, vtag.stderr);
  }
}

T.finish();
