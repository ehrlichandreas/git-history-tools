/* AC-57 -- item 0 (CRITICAL, Lead-directed, found resigning an
 * already-signed tag): `resign-tags` and `resign-commits` built the
 * message for a re-created tag from `for-each-ref --format=%(contents)`
 * -- which, for an ALREADY-SIGNED tag, includes the existing trailing
 * PGP signature block as part of its own output (git's own documented
 * behaviour). Feeding that straight back in as the NEW tag's message via
 * `-F` embedded the OLD signature as literal text inside the new
 * message, which then received a second, genuinely new signature
 * appended right after it -- a tag object with TWO concatenated
 * signature blocks.
 *
 * Neither of the two checks that should obviously have caught this
 * actually did: `stripSignature`/`tagBodyMinusSig` truncate at the FIRST
 * marker on both the before and after side, so the (corrupted) new body
 * and the (clean) old body still compared byte-identical; `git tag -v`
 * verified the first of the two blocks happily, never noticing the
 * second. Both are exercised directly here, not just the fix itself.
 *
 * The fix: the message is now read from the raw object's own bytes
 * (never %(contents)), truncated at the first signature marker -- the
 * correct behaviour regardless of how many blocks follow, since
 * everything from the first one onward is signature material. A new
 * defensive guard (exactly 1 signature block in the verification) is
 * pinned here by mutation, reverting to the old %(contents)-based
 * extraction and confirming `verify: ...: FAILED (multiple-signatures)`
 * is what the apply run itself would have reported, not a silent OK. */
import * as H from '../lib/harness.ts';
const T = H.T;

H.requireBin('git-sign');

function sigBlocks(raw: string): number {
  return (raw.match(/-----BEGIN PGP SIGNATURE-----/g) || []).length;
}

/* ---- 1: resign-tags on an ALREADY-SIGNED tag -------------------------- */
{
  const gpg = H.setupGpg('ac57-resigntags');
  if (gpg) {
    const repo = H.initRepo('ac57-resigntags', gpg);
    const root = H.commit(repo, gpg, 'root', { 'a.txt': 'one\n' }, { date: '@1000000000 +0000' }).sha!;
    H.tagSigned(repo, gpg, 'v-presigned', 'the real tag message');
    const rawBefore = H.catFile(repo, gpg, 'refs/tags/v-presigned', '-p');
    T.check('fixture: v-presigned starts out with exactly 1 signature block', sigBlocks(rawBefore) === 1);

    const policy = H.writePolicy('ac57-resigntags', { signingKey: gpg.fingerprint, timezone: 'UTC' });
    /* Named explicitly: resign-tags re-signs it even though it is
     * already validly signed by the policy key -- the exact real-world
     * "re-sign something that was already fine" case the bug hit. */
    const out = H.runBin('git-sign', ['resign-tags', repo, 'v-presigned', '--apply', '--policy=' + policy], { gnupgHome: gpg.gnupgHome });
    T.exit('AC-57.1: apply exit 0', out, 0);
    T.contains('AC-57.1: verify reports OK, not FAILED', out.stdout, 'verify: v-presigned: OK');

    const rawAfter = H.catFile(repo, gpg, 'refs/tags/v-presigned', '-p');
    T.eq('AC-57.1: exactly 1 signature block after resign, not 2', sigBlocks(rawAfter), 1);
    const msgIdx = rawAfter.indexOf('\n\n');
    const messageAndSig = rawAfter.slice(msgIdx + 2);
    const sigIdx = messageAndSig.indexOf('-----BEGIN PGP SIGNATURE-----');
    T.eq('AC-57.1: the message itself is exactly the original text, nothing embedded',
      messageAndSig.slice(0, sigIdx), 'the real tag message\n');

    const verifyTag = H.gitIn(repo, gpg)(['tag', '-v', 'v-presigned']);
    T.check('AC-57.1: git tag -v still accepts it', verifyTag.status === 0, verifyTag.stderr);
    const checkOut = H.runBin('git-sign', ['check', repo, '--range=' + root + '..' + root, '--tags', '--policy=' + policy], { gnupgHome: gpg.gnupgHome });
    T.check('AC-57.1: check --tags reports 0 violations', checkOut.stdout.startsWith('check: 0 violation'), checkOut.stdout);
  }
}

/* ---- 2: resign-commits re-creating an ALREADY-SIGNED tag -------------- */
{
  const gpg = H.setupGpg('ac57-resigncommits');
  if (gpg) {
    const repo = H.initRepo('ac57-resigncommits', gpg);
    const c0 = H.commit(repo, gpg, 'root (lower, excluded)', { 'a.txt': 'one\n' }, { date: '@1000000000 +0000' }).sha!;
    H.commit(repo, gpg, 'in range', { 'b.txt': 'two\n' }, { date: '@1000000100 +0000' });
    H.tagSigned(repo, gpg, 'v-presigned2', 'another real tag message');

    const policy = H.writePolicy('ac57-resigncommits', { signingKey: gpg.fingerprint, timezone: 'UTC' });
    const range = c0 + '..main';
    const out = H.runBin('git-sign', ['resign-commits', repo, range, '--apply', '--policy=' + policy], { gnupgHome: gpg.gnupgHome });
    T.exit('AC-57.2: apply exit 0', out, 0);
    T.contains('AC-57.2: verify check (signature/sig-time) OK', out.stdout, 'verify: resign-commits: check (signature/sig-time): OK');

    const rawAfter = H.catFile(repo, gpg, 'refs/tags/v-presigned2', '-p');
    T.eq('AC-57.2: exactly 1 signature block after resign, not 2', sigBlocks(rawAfter), 1);
    const msgIdx = rawAfter.indexOf('\n\n');
    const messageAndSig = rawAfter.slice(msgIdx + 2);
    const sigIdx = messageAndSig.indexOf('-----BEGIN PGP SIGNATURE-----');
    T.eq('AC-57.2: the message itself is exactly the original text, nothing embedded',
      messageAndSig.slice(0, sigIdx), 'another real tag message\n');

    const checkOut = H.runBin('git-sign', ['check', repo, '--range=' + range, '--tags', '--policy=' + policy], { gnupgHome: gpg.gnupgHome });
    T.check('AC-57.2: check --tags reports 0 violations', checkOut.stdout.startsWith('check: 0 violation'), checkOut.stdout);
  }
}

T.finish();
