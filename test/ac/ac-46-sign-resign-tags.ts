/* AC-46 -- § 5.3 `resign-tags`: without arguments, selects every annotated
 * tag NOT validly signed by the policy key (an unsigned tag counts; one
 * already signed by the policy key does not); skips lightweight tags
 * (reported, not an error); --apply creates the backup bundle first,
 * re-signs each selected tag with its target/tagger line/message bytes
 * unchanged, prints `<tag> <old> -> <new>`, verifies, and never pushes --
 * it prints the push command instead. */
import { spawnSync } from 'node:child_process';
import * as H from '../lib/harness.ts';
const T = H.T;

H.requireBin('git-sign');

function tagBodyMinusSig(repo: string, gpg: H.Gpg, tag: string): string {
  const raw = H.catFile(repo, gpg, tag, '-p');
  const idx = raw.indexOf('-----BEGIN PGP SIGNATURE-----');
  return idx === -1 ? raw : raw.slice(0, idx);
}

/** How many `-----BEGIN PGP SIGNATURE-----` markers `tag`'s raw object
 * actually contains -- a normal signed tag has exactly 1. Hardening
 * (Lead-directed, follow-up to the %(contents) bug this file's own
 * `tagBodyMinusSig` could not catch on its own): `tagBodyMinusSig`
 * truncates at the FIRST marker on both the before and after side, so a
 * tag corrupted with TWO concatenated signature blocks (the OLD one
 * embedded as literal message text, via `for-each-ref
 * --format=%(contents)` on an already-signed tag, plus a genuinely NEW
 * one appended after it) still produced byte-identical `tagBodyMinusSig`
 * results on both sides, and `git tag -v` verified the first block
 * happily -- neither existing assertion below actually exercised this. */
function sigBlockCount(repo: string, gpg: H.Gpg, tag: string): number {
  const raw = H.catFile(repo, gpg, tag, '-p');
  return (raw.match(/-----BEGIN PGP SIGNATURE-----/g) || []).length;
}

{
  const gpg = H.setupGpg('ac46-resign');
  const other = H.setupGpg('ac46-resign-other');
  if (gpg && other) {
    const repo = H.initRepoNoSignConfig('ac46-resign', gpg);
    H.commit(repo, gpg, 'root', { 'a.txt': 'one\n' }, { date: '@1000000000 +0000' });

    /* unsigned-annotated and lightweight both sit on HEAD; a tag already
     * signed by a DIFFERENT key stands in for the real leaked-signature-
     * time scenario -- resigning swaps only the signature. */
    H.tagAnnotatedUnsigned(repo, gpg, 'v-unsigned', 'an unsigned annotated tag');
    H.tagLightweight(repo, gpg, 'v-light');
    const otherEnv = Object.assign({}, gpg.env, { GNUPGHOME: other.gnupgHome });
    const r = spawnSync('git',
      ['-c', 'user.signingkey=' + other.fingerprint, '-c', 'gpg.program=gpg', 'tag', '-s', 'v-wrongkey', '-m', 'signed by someone else'],
      { cwd: repo, env: otherEnv, encoding: 'utf8' });
    T.check('fixture: v-wrongkey signed by the OTHER key', r.status === 0, r.stderr);

    const policy = H.writePolicy('ac46-resign', { signingKey: gpg.fingerprint, timezone: 'UTC' });
    const before = {
      unsigned: H.revParse(repo, gpg, 'v-unsigned'),
      wrongkey: H.revParse(repo, gpg, 'v-wrongkey'),
      light: H.revParse(repo, gpg, 'v-light'),
    };
    const unsignedBodyBefore = tagBodyMinusSig(repo, gpg, 'v-unsigned');
    const wrongkeyBodyBefore = tagBodyMinusSig(repo, gpg, 'v-wrongkey');

    const dryObjBefore = H.objectStoreSnapshot(repo, gpg);
    const dry = H.runBin('git-sign', ['resign-tags', repo, '--policy=' + policy], { gnupgHome: gpg.gnupgHome });
    T.exit('AC-46 dry run: exit 0', dry, 0);
    T.contains('AC-46 dry run: lists v-unsigned as a candidate', dry.stdout, 'v-unsigned');
    T.contains('AC-46 dry run: lists v-wrongkey as a candidate', dry.stdout, 'v-wrongkey');
    T.contains('AC-46 dry run: v-light is reported as skipped (lightweight)', dry.stdout, 'v-light is lightweight, skipped');
    T.eq('AC-46 dry run: no refs moved', H.revParse(repo, gpg, 'v-unsigned'), before.unsigned);
    const dryObjAfter = H.objectStoreSnapshot(repo, gpg);
    T.eq('AC-46 dry run: no new objects written (D2)', H.objectStoreDiff(dryObjBefore, dryObjAfter).added, []);

    const apply = H.runBin('git-sign', ['resign-tags', repo, '--policy=' + policy, '--apply'], { gnupgHome: gpg.gnupgHome });
    T.exit('AC-46 apply: exit 0', apply, 0);
    T.check('AC-46 apply: creates a backup bundle', !!H.findBackupBundle(repo));
    T.contains('AC-46 apply: prints <tag> <old> -> <new> for v-unsigned', apply.stdout, 'v-unsigned ' + before.unsigned + ' -> ');
    T.contains('AC-46 apply: prints the push command, never pushes', apply.stdout, 'git push --force-with-lease=refs/tags/v-unsigned:' + before.unsigned);
    T.contains('AC-46 apply: prints its own verify: v-unsigned: OK', apply.stdout, 'verify: v-unsigned: OK');
    T.contains('AC-46 apply: prints its own verify: v-wrongkey: OK', apply.stdout, 'verify: v-wrongkey: OK');

    T.check('AC-46 apply: v-unsigned object sha changed (new signature)', H.revParse(repo, gpg, 'v-unsigned') !== before.unsigned);
    T.eq('AC-46 apply: v-unsigned still points at the same target commit', H.revParse(repo, gpg, 'v-unsigned^{commit}'), H.revParse(repo, gpg, 'HEAD'));
    T.eq('AC-46 apply: v-unsigned tagger/message bytes unchanged', tagBodyMinusSig(repo, gpg, 'v-unsigned'), unsignedBodyBefore);
    T.eq('AC-46 apply: v-wrongkey tagger/message bytes unchanged', tagBodyMinusSig(repo, gpg, 'v-wrongkey'), wrongkeyBodyBefore);
    T.eq('AC-46 apply: v-light (lightweight) left untouched', H.revParse(repo, gpg, 'v-light'), before.light);

    /* v-wrongkey was ALREADY signed (by the other key) before this run --
     * exactly the case the %(contents) bug corrupted: its OWN prior
     * signature block ending up embedded as literal message text, with a
     * second, genuinely new one appended after it. */
    T.eq('AC-46 apply: v-unsigned has exactly 1 signature block (was never signed before)', sigBlockCount(repo, gpg, 'v-unsigned'), 1);
    T.eq('AC-46 apply: v-wrongkey has exactly 1 signature block (was ALREADY signed before -- the exposed case)', sigBlockCount(repo, gpg, 'v-wrongkey'), 1);

    const verifyUnsigned = H.gitIn(repo, gpg)(['tag', '-v', 'v-unsigned']);
    T.check('AC-46 apply: v-unsigned now has a good signature by the policy key', verifyUnsigned.status === 0, verifyUnsigned.stderr);
    const verifyWrongkey = H.gitIn(repo, gpg)(['tag', '-v', 'v-wrongkey']);
    T.check('AC-46 apply: v-wrongkey now has a good signature by the policy key', verifyWrongkey.status === 0, verifyWrongkey.stderr);

    /* A second run with no arguments finds nothing left to fix. */
    const again = H.runBin('git-sign', ['resign-tags', repo, '--policy=' + policy], { gnupgHome: gpg.gnupgHome });
    T.exit('AC-46 re-run: exit 0', again, 0);
    T.contains('AC-46 re-run: nothing left to resign', again.stdout, 'nothing to resign');
  }
}

{
  const gpg = H.setupGpg('ac46-explicit');
  if (gpg) {
    const repo = H.initRepoNoSignConfig('ac46-explicit', gpg);
    H.commit(repo, gpg, 'root', { 'a.txt': 'one\n' }, { date: '@1000000000 +0000' });
    H.tagSigned(repo, gpg, 'v-already-good');
    const policy = H.writePolicy('ac46-explicit', { signingKey: gpg.fingerprint, timezone: 'UTC' });
    const before = H.revParse(repo, gpg, 'v-already-good');

    /* Already validly signed by the policy key -- the default (no
     * explicit list) selection skips it, but naming it explicitly still
     * resigns it. */
    const skip = H.runBin('git-sign', ['resign-tags', repo, '--policy=' + policy], { gnupgHome: gpg.gnupgHome });
    T.check('AC-46 explicit: a tag already correctly signed is not selected by default', !skip.stdout.includes('v-already-good'));

    const r = H.runBin('git-sign', ['resign-tags', repo, 'v-already-good', '--policy=' + policy, '--apply'], { gnupgHome: gpg.gnupgHome });
    T.exit('AC-46 explicit: an explicitly named tag is resigned even if already valid', r, 0);
    T.check('AC-46 explicit: object sha changed', H.revParse(repo, gpg, 'v-already-good') !== before);
    /* v-already-good was ALREADY validly signed by the policy key itself
     * before this run -- the single most realistic real-world case (a
     * tag re-signed a second time, nothing wrong with it the first time
     * either) and exactly the case the %(contents) bug corrupted. */
    T.eq('AC-46 explicit: v-already-good has exactly 1 signature block, not 2', sigBlockCount(repo, gpg, 'v-already-good'), 1);

    const missing = H.runBin('git-sign', ['resign-tags', repo, 'no-such-tag', '--policy=' + policy], { gnupgHome: gpg.gnupgHome });
    T.exit('AC-46 explicit: naming a nonexistent tag is a usage error, exit 2', missing, 2);
  }
}

T.finish();
