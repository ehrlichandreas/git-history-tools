/* AC-65 -- D16 follow-up (HIGH, Lead-found via the Reviewer's pre-review
 * of D16 itself, task 01a14ca4): an UNSIGNED annotated tag whose message
 * quotes a complete PGP block in the MIDDLE, with real text after it, lost
 * everything from the quote onward on `resign-tags --apply` -- `verify: OK`
 * reported even though the message was silently truncated.
 *
 * Root cause: `lastTagSignatureBeginIndex` (the function AC-61/D16 fixed
 * the FIRST-marker rule into) found the quote's own `-----BEGIN...-----`
 * via a bare `lastIndexOf`, with no notion of "is this actually trailing
 * the object", even though `stackedTagBlockCount`/`signatureBlockCount`'s
 * OWN backward walk correctly said 0 (nothing real at EOF). The two
 * disagreed exactly in this one case: a SIGNED tag with an earlier quote
 * (AC-61's own fixtures) never exposed it, because there the real trailing
 * signature genuinely IS the last marker either way. Only an UNSIGNED tag
 * with a mid-message quote exposes it -- that's the difference from AC-61.
 *
 * Fix: ONE function, `tagSignatureBoundary` (siginfo.ts), the backward walk
 * itself, used by every caller (`tagMessageFromRaw`, `stripSignature`,
 * `extractSignature`'s tag branch, `signatureBlockCount`'s tag branch) --
 * no second `lastIndexOf` scan anywhere to disagree with it. `cmdResignTags`'
 * own verify step also gained an INDEPENDENT second check
 * (`independentOldTagMessage`, a regex anchored at EOF, never the
 * line-by-line walk) so a bug shared between the old and new side can't
 * silently cancel out and still report `OK` the way it did here.
 *
 * Also decided here (D18, Lead-directed): an unsigned tag whose message
 * ENDS with a complete quoted block, nothing real after it, is genuinely
 * indistinguishable from a tag that IS signed but whose signature gpg
 * can't verify or attribute to any key (SPEC § 5.5's own "if one follows"
 * ambiguity) -- both `resign-tags` and `resign-commits`' tag-on-tag path
 * now REFUSE on that shape (exit 1, naming the tag) rather than guess. */
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

function tagMessageOf(repo: string, gpg: H.Gpg, tag: string): string {
  const raw = H.catFile(repo, gpg, tag, '-p');
  const idx = raw.indexOf('\n\n');
  return idx === -1 ? '' : raw.slice(idx + 2);
}

const quotedMidMessage = [
  'Preamble text before the quote.',
  '',
  '-----BEGIN PGP SIGNATURE-----',
  '',
  'iHUEABYKAB0WIQQAAAAAAAAAAAAAAAAAAAAAAAAAAAUCAAAAAAAKCRAAAAAAAAAA',
  '=AAAA',
  '-----END PGP SIGNATURE-----',
  '',
  'Real trailing text that must survive the resign.',
].join('\n');

/* ------------------------- D18a: resign-tags, unsigned, quote + text -- */
{
  const gpg = H.setupGpg('ac62-unsigned-quote-tag');
  if (gpg) {
    const repo = H.initRepo('ac62-unsigned-quote-tag', gpg);
    H.commit(repo, gpg, 'root', { 'a.txt': 'one\n' }, { date: '@1000000000 +0000' });
    H.tagAnnotatedUnsigned(repo, gpg, 'v-unsigned-quote', quotedMidMessage);
    T.eq('fixture: v-unsigned-quote has 0 stacked blocks (genuinely unsigned)',
      sigBlockCountTag(repo, gpg, 'v-unsigned-quote'), 0);

    const policy = H.writePolicy('ac62-unsigned-quote-tag', { signingKey: gpg.fingerprint, timezone: 'UTC' });
    const apply = H.runBin('git-sign', ['resign-tags', repo, 'v-unsigned-quote', '--apply', '--policy=' + policy],
      { gnupgHome: gpg.gnupgHome });
    T.exit('AC-65 D18a: resign-tags apply exits 0', apply, 0);
    T.contains('AC-65 D18a: verify reports OK', apply.stdout, 'v-unsigned-quote: OK');

    const msgAfter = tagMessageOf(repo, gpg, 'v-unsigned-quote');
    T.check('AC-65 D18a: the FULL message survives byte-exact, including everything after the quote',
      msgAfter.startsWith(quotedMidMessage), msgAfter);
    T.eq('AC-65 D18a: exactly 1 real signature block after resigning', sigBlockCountTag(repo, gpg, 'v-unsigned-quote'), 1);

    const check = H.runBin('git-sign', ['check', repo, 'HEAD', '--tags', '--policy=' + policy], { gnupgHome: gpg.gnupgHome });
    T.check('AC-65 D18a: check is clean after resigning (no signature/message violation)',
      !/ (signature|message) /.test(check.stdout), check.stdout);
  }
}

/* ------------------- D18a via resign-commits (tag-on-commit path) ----- */
{
  const gpg = H.setupGpg('ac62-unsigned-quote-rc');
  if (gpg) {
    const repo = H.initRepo('ac62-unsigned-quote-rc', gpg);
    const c0 = H.commit(repo, gpg, 'root', { 'a.txt': 'one\n' }, { date: '@1000000000 +0000' }).sha!;
    const c1 = H.commit(repo, gpg, 'second', { 'b.txt': 'two\n' }, { date: '@1000000100 +0000' }).sha!;
    H.tagAnnotatedUnsigned(repo, gpg, 'v-unsigned-quote-rc', quotedMidMessage);
    T.eq('fixture: v-unsigned-quote-rc has 0 stacked blocks (genuinely unsigned)',
      sigBlockCountTag(repo, gpg, 'v-unsigned-quote-rc'), 0);

    const policy = H.writePolicy('ac62-unsigned-quote-rc', { signingKey: gpg.fingerprint, timezone: 'UTC' });
    const apply = H.runBin('git-sign', ['resign-commits', repo, c0 + '..' + c1, '--apply', '--policy=' + policy],
      { gnupgHome: gpg.gnupgHome });
    T.exit('AC-65 D18a (resign-commits tag path): apply exits 0', apply, 0);

    const msgAfter = tagMessageOf(repo, gpg, 'v-unsigned-quote-rc');
    T.check('AC-65 D18a (resign-commits tag path): the FULL message survives byte-exact',
      msgAfter.startsWith(quotedMidMessage), msgAfter);
    T.eq('AC-65 D18a (resign-commits tag path): exactly 1 real signature block after resigning',
      sigBlockCountTag(repo, gpg, 'v-unsigned-quote-rc'), 1);
  }
}

const endsInQuoteMessage = [
  'An unsigned tag whose message happens to end with a complete block:',
  '-----BEGIN PGP SIGNATURE-----',
  '',
  'iHUEABYKAB0WIQQAAAAAAAAAAAAAAAAAAAAAAAAAAAUCAAAAAAAKCRAAAAAAAAAA',
  '=AAAA',
  '-----END PGP SIGNATURE-----',
].join('\n');

/* ---------------- D18b: resign-tags refuses the ambiguous ending ------ */
{
  const gpg = H.setupGpg('ac62-ambiguous-tag');
  if (gpg) {
    const repo = H.initRepo('ac62-ambiguous-tag', gpg);
    H.commit(repo, gpg, 'root', { 'a.txt': 'one\n' }, { date: '@1000000000 +0000' });
    H.tagAnnotatedUnsigned(repo, gpg, 'v-ambiguous', endsInQuoteMessage);
    T.eq('fixture: v-ambiguous has 1 stacked block (indistinguishable from a real trailing signature)',
      sigBlockCountTag(repo, gpg, 'v-ambiguous'), 1);
    const oldSha = H.revParse(repo, gpg, 'refs/tags/v-ambiguous');

    const policy = H.writePolicy('ac62-ambiguous-tag', { signingKey: gpg.fingerprint, timezone: 'UTC' });
    const apply = H.runBin('git-sign', ['resign-tags', repo, 'v-ambiguous', '--apply', '--policy=' + policy],
      { gnupgHome: gpg.gnupgHome });
    T.exit('AC-65 D18b: resign-tags refuses (exit 1), does not guess', apply, 1);
    T.contains('AC-65 D18b: refusal names the tag', apply.stderr, 'v-ambiguous');
    T.contains('AC-65 D18b: refusal explains the ambiguity', apply.stderr, 'indistinguishable');

    const newSha = H.revParse(repo, gpg, 'refs/tags/v-ambiguous');
    T.eq('AC-65 D18b: the tag ref never moved', newSha, oldSha);
  }
}

/* ------- D18b via resign-commits (tag-on-tag path), same refusal ------ */
{
  const gpg = H.setupGpg('ac62-ambiguous-rc');
  if (gpg) {
    const repo = H.initRepo('ac62-ambiguous-rc', gpg);
    const c0 = H.commit(repo, gpg, 'root', { 'a.txt': 'one\n' }, { date: '@1000000000 +0000' }).sha!;
    const c1 = H.commit(repo, gpg, 'second', { 'b.txt': 'two\n' }, { date: '@1000000100 +0000' }).sha!;
    H.tagAnnotatedUnsigned(repo, gpg, 'v-ambiguous-rc', endsInQuoteMessage);
    const oldTagSha = H.revParse(repo, gpg, 'refs/tags/v-ambiguous-rc');
    const oldHeadSha = H.revParse(repo, gpg, 'HEAD');

    const policy = H.writePolicy('ac62-ambiguous-rc', { signingKey: gpg.fingerprint, timezone: 'UTC' });
    const apply = H.runBin('git-sign', ['resign-commits', repo, c0 + '..' + c1, '--apply', '--policy=' + policy],
      { gnupgHome: gpg.gnupgHome });
    T.exit('AC-65 D18b (resign-commits tag path): refuses (exit 1)', apply, 1);
    T.contains('AC-65 D18b (resign-commits tag path): refusal names the tag', apply.stderr, 'v-ambiguous-rc');

    const newTagSha = H.revParse(repo, gpg, 'refs/tags/v-ambiguous-rc');
    const newHeadSha = H.revParse(repo, gpg, 'HEAD');
    T.eq('AC-65 D18b (resign-commits tag path): the tag ref never moved', newTagSha, oldTagSha);
    T.eq('AC-65 D18b (resign-commits tag path): HEAD never moved either (all-or-nothing, nothing resigned)',
      newHeadSha, oldHeadSha);
  }
}

T.finish();
