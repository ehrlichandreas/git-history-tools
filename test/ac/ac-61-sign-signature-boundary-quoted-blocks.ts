/* AC-61 -- D1/D2 (Lead-directed, task 01a14ca4 pre-review): the item-0
 * fix's "truncate the message at the first signature marker" rule, and
 * `signatureBlockCount`'s "count every marker anywhere in the object"
 * rule, both over-fire on an object whose MESSAGE legitimately quotes a
 * signature block as literal text (e.g. pasting an old security advisory
 * into a release tag) or a line that merely starts with "gpgsig " as
 * prose, not a real header.
 *
 * D1 (tags): the signature boundary is now the LAST signature-marker
 * line in the object, not the first -- `lastTagSignatureBeginIndex`
 * (siginfo.ts). "multiple-signatures" is redefined to mean the message
 * part (everything before that last marker) itself ends with a COMPLETE
 * armored block (a `stackedTagBlockCount` walk backward from EOF) --
 * exactly the item-0 shape (an old signature immediately followed by a
 * new one, nothing between). A quote followed by further real text does
 * NOT count, since nothing abuts the final signature in that case.
 *
 * D2 (commits): `signatureBlockCount`/`extractSignature` for a commit now
 * scan ONLY the header region (up to the first blank line) for
 * `gpgsig `/`gpgsig-sha256 ` lines -- never the whole object, which also
 * includes the MESSAGE, where a line that happens to start with
 * "gpgsig " as prose must not be miscounted as a second signature. */
import * as H from '../lib/harness.ts';
const T = H.T;

H.requireBin('git-sign');

function sigBlockCountTag(repo: string, gpg: H.Gpg, tag: string): number {
  const raw = H.catFile(repo, gpg, tag, '-p');
  let i = raw.split('\n').length;
  const lines = raw.split('\n');
  let count = 0;
  for (;;) {
    while (i > 0 && lines[i - 1].trim() === '') i--;
    if (i === 0) break;
    if (lines[i - 1] !== '-----END PGP SIGNATURE-----') break;
    let j = i - 2;
    while (j >= 0 && lines[j] !== '-----BEGIN PGP SIGNATURE-----') j--;
    if (j < 0) break;
    count++;
    i = j;
  }
  return count;
}

/* ------------------------------------------- D1a: quote + real text --- */
{
  const gpg = H.setupGpg('ac61-quote-tag');
  if (gpg) {
    const repo = H.initRepo('ac61-quote-tag', gpg);
    H.commit(repo, gpg, 'root', { 'a.txt': 'one\n' }, { date: '@1000000000 +0000' });

    const quotedMessage = [
      'Release notes.',
      '',
      'For reference, here is an old advisory signature we published before:',
      '-----BEGIN PGP SIGNATURE-----',
      '',
      'iHUEABYKAB0WIQQAAAAAAAAAAAAAAAAAAAAAAAAAAAUCAAAAAAAKCRAAAAAAAAAA',
      'AAAAAP0AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQD9AAAAAAAAAAAA',
      '=AAAA',
      '-----END PGP SIGNATURE-----',
      '',
      'That key has since been retired. Thanks for reading.',
    ].join('\n');
    H.tagSigned(repo, gpg, 'v-quoted', quotedMessage);

    const policy = H.writePolicy('ac61-quote-tag', { signingKey: gpg.fingerprint, timezone: 'UTC' });

    const check1 = H.runBin('git-sign', ['check', repo, 'HEAD', '--tags', '--policy=' + policy], { gnupgHome: gpg.gnupgHome });
    T.check('AC-61 D1a: check is clean on the quoted-block tag (no false multiple-signatures)',
      !check1.stdout.includes('multiple-signatures'), check1.stdout);
    T.exit('AC-61 D1a: check exits 0', check1, 0);
    T.eq('AC-61 D1a: exactly 1 real signature block (the quote is not counted)', sigBlockCountTag(repo, gpg, 'v-quoted'), 1);

    const dry = H.runBin('git-sign', ['resign-tags', repo, 'v-quoted', '--policy=' + policy], { gnupgHome: gpg.gnupgHome });
    T.exit('AC-61 D1a: resign-tags dry run exits 0 (not refused as corrupted)', dry, 0);

    const apply = H.runBin('git-sign', ['resign-tags', repo, 'v-quoted', '--apply', '--policy=' + policy], { gnupgHome: gpg.gnupgHome });
    T.exit('AC-61 D1a: resign-tags apply exits 0', apply, 0);
    const msgAfterResignTags = H.catFile(repo, gpg, 'v-quoted', '-p').split('\n\n').slice(1).join('\n\n');
    T.check('AC-61 D1a: resign-tags preserves the FULL message byte-exact, including everything after the quote',
      msgAfterResignTags.startsWith(quotedMessage), msgAfterResignTags);
    T.eq('AC-61 D1a: exactly 1 signature block after resign-tags', sigBlockCountTag(repo, gpg, 'v-quoted'), 1);

    const check2 = H.runBin('git-sign', ['check', repo, 'HEAD', '--tags', '--policy=' + policy], { gnupgHome: gpg.gnupgHome });
    T.check('AC-61 D1a: check is still clean after resign-tags', !check2.stdout.includes('multiple-signatures'), check2.stdout);
    T.exit('AC-61 D1a: check exits 0 after resign-tags', check2, 0);
  }
}

/* --------------------------------- D1a via resign-commits (tag path) -- */
{
  const gpg = H.setupGpg('ac61-quote-rc');
  if (gpg) {
    const repo = H.initRepo('ac61-quote-rc', gpg);
    const c0 = H.commit(repo, gpg, 'root', { 'a.txt': 'one\n' }, { date: '@1000000000 +0000' }).sha!;
    const c1 = H.commit(repo, gpg, 'second', { 'b.txt': 'two\n' }, { date: '@1000000100 +0000' }).sha!;
    const quotedMessage = [
      'Quoted below, an old block, followed by real content.',
      '-----BEGIN PGP SIGNATURE-----',
      '',
      'iHUEABYKAB0WIQQAAAAAAAAAAAAAAAAAAAAAAAAAAAUCAAAAAAAKCRAAAAAAAAAA',
      '=AAAA',
      '-----END PGP SIGNATURE-----',
      '',
      'Real content continues here.',
    ].join('\n');
    H.tagSigned(repo, gpg, 'v-quoted-rc', quotedMessage);

    const policy = H.writePolicy('ac61-quote-rc', { signingKey: gpg.fingerprint, timezone: 'UTC' });
    const apply = H.runBin('git-sign', ['resign-commits', repo, c0 + '..' + c1, '--apply', '--policy=' + policy], { gnupgHome: gpg.gnupgHome });
    T.exit('AC-61 D1a (resign-commits tag path): apply exits 0', apply, 0);
    T.eq('AC-61 D1a (resign-commits tag path): exactly 1 signature block', sigBlockCountTag(repo, gpg, 'v-quoted-rc'), 1);
    const msgAfter = H.catFile(repo, gpg, 'v-quoted-rc', '-p').split('\n\n').slice(1).join('\n\n');
    T.check('AC-61 D1a (resign-commits tag path): full message preserved including the part after the quote',
      msgAfter.startsWith(quotedMessage), msgAfter);
  }
}

/* --------------------------- D1b: quote immediately before real sig --- */
{
  const gpg = H.setupGpg('ac61-abut-tag');
  if (gpg) {
    const repo = H.initRepo('ac61-abut-tag', gpg);
    H.commit(repo, gpg, 'root', { 'a.txt': 'one\n' }, { date: '@1000000000 +0000' });

    /* A quoted block with NOTHING (no further real text) between it and
     * the real trailing signature is genuinely indistinguishable from
     * item-0's corruption shape -- D1 says this case still counts as
     * `multiple-signatures`, deliberately, since there is no way to tell
     * "a quote that happens to abut the signature" apart from "an old
     * signature that became message text" from the object's bytes alone. */
    const abuttingMessage = [
      'Quoted block immediately before the real signature:',
      '-----BEGIN PGP SIGNATURE-----',
      '',
      'iHUEABYKAB0WIQQAAAAAAAAAAAAAAAAAAAAAAAAAAAUCAAAAAAAKCRAAAAAAAAAA',
      '=AAAA',
      '-----END PGP SIGNATURE-----',
    ].join('\n');
    H.tagSigned(repo, gpg, 'v-abutting', abuttingMessage);
    T.eq('fixture: v-abutting really has 2 stacked blocks (the quote abuts the real signature)',
      sigBlockCountTag(repo, gpg, 'v-abutting'), 2);

    const policy = H.writePolicy('ac61-abut-tag', { signingKey: gpg.fingerprint, timezone: 'UTC' });
    const check = H.runBin('git-sign', ['check', repo, 'HEAD', '--tags', '--policy=' + policy], { gnupgHome: gpg.gnupgHome });
    T.contains('AC-61 D1b: check reports multiple-signatures for the abutting-quote shape', check.stdout, 'multiple-signatures');
    T.exit('AC-61 D1b: check exits 1', check, 1);
  }
}

/* --------------------------------------- D2: "gpgsig " as prose text -- */
{
  const gpg = H.setupGpg('ac61-gpgsig-prose');
  if (gpg) {
    const repo = H.initRepo('ac61-gpgsig-prose', gpg);
    H.commit(repo, gpg, 'root', { 'a.txt': 'one\n' }, { date: '@1000000000 +0000' });
    /* A GENUINELY, validly signed commit (one real `gpgsig` header) whose
     * own MESSAGE also contains a line starting with "gpgsig " as prose
     * -- the whole-object scan this replaces would count both the real
     * header AND this message line, miscounting 2 and reporting a false
     * `multiple-signatures`; the header-region-only scan counts only the
     * real one. */
    H.commit(repo, gpg,
      'document the header\n\ngpgsig lines in a raw commit object look like this, ' +
      'folded with a leading space on continuation lines.',
      { 'b.txt': 'two\n' }, { date: '@1000000100 +0000' });
    const sha = H.shortSha(repo, gpg, 'HEAD');

    const policy = H.writePolicy('ac61-gpgsig-prose', { signingKey: gpg.fingerprint, timezone: 'UTC' });
    const check = H.runBin('git-sign', ['check', repo, sha, '--policy=' + policy], { gnupgHome: gpg.gnupgHome });
    T.check('AC-61 D2: a message line starting with "gpgsig " is never counted as a second signature',
      !check.stdout.includes('multiple-signatures'), check.stdout);
    T.exit('AC-61 D2: check exits 0 (a validly signed commit, correctly read as 1 signature)', check, 0);
  }
}

T.finish();
