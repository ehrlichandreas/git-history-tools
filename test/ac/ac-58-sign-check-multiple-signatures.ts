/* AC-58 -- item 0's 3rd guard (CRITICAL follow-up, Lead-directed): `check`
 * must detect an object with more than one embedded PGP signature block
 * and report it as its own distinct violation, `multiple-signatures` --
 * never silently pass it as clean, never misreport it as `missing` (the
 * natural failure mode if the multi-block case fell through to
 * `extractSignature`'s normal null-means-missing path), and never crash.
 *
 * This is deliberately NOT exercised by driving `resign-tags`/
 * `resign-commits` (AC-57 already does that, for the specific
 * %(contents) root cause) -- these fixtures hand-construct a malformed
 * object directly via `git hash-object --literally`, standing in for
 * ANY tool or manual mistake that could produce this shape, not just
 * this one now-fixed bug. `check` must catch it regardless of how it got
 * there. */
import * as H from '../lib/harness.ts';
const T = H.T;

H.requireBin('git-sign');

/* ---- 1: a tag with two concatenated signature blocks ------------------ */
{
  const gpg = H.setupGpg('ac58-tag');
  if (gpg) {
    const repo = H.initRepo('ac58-tag', gpg);
    H.commit(repo, gpg, 'root', { 'a.txt': 'one\n' }, { date: '@1000000000 +0000' });
    H.tagSigned(repo, gpg, 'mytag', 'hello');
    const git = H.gitIn(repo, gpg);

    const raw = H.catFile(repo, gpg, 'refs/tags/mytag', '-p');
    const sigIdx = raw.indexOf('-----BEGIN PGP SIGNATURE-----');
    const sigBlock = raw.slice(sigIdx);
    const doubled = raw + '\n' + sigBlock;
    const hash = git(['hash-object', '-t', 'tag', '-w', '--literally', '--stdin'], { input: doubled });
    T.check('fixture: double-signature tag object written', hash.status === 0, hash.stderr);
    const newOid = hash.stdout.trim();
    T.check('fixture: really has 2 signature blocks',
      (H.catFile(repo, gpg, newOid, '-p').match(/-----BEGIN PGP SIGNATURE-----/g) || []).length === 2);
    git(['update-ref', 'refs/tags/mytag', newOid]);

    const policy = H.writePolicy('ac58-tag', { signingKey: gpg.fingerprint, timezone: 'UTC' });
    const root = H.revParse(repo, gpg, 'HEAD');
    const out = H.runBin('git-sign', ['check', repo, '--range=' + root + '..' + root, '--tags', '--policy=' + policy], { gnupgHome: gpg.gnupgHome });
    T.contains('AC-58.1: reports multiple-signatures for the tag, naming the block count', out.stdout, 'mytag signature multiple-signatures (2 signature blocks found)');
    T.check('AC-58.1: does NOT also report it as missing/bad/etc', !/mytag signature (missing|bad|signed by|good signature)/.test(out.stdout), out.stdout);
    T.exit('AC-58.1: exit 1 (a real violation)', out, 1);
  }
}

/* ---- 2: a commit with two gpgsig headers ------------------------------ */
{
  const gpg = H.setupGpg('ac58-commit');
  if (gpg) {
    const repo = H.initRepo('ac58-commit', gpg);
    const c0 = H.commit(repo, gpg, 'root', { 'a.txt': 'one\n' }, { date: '@1000000000 +0000' }).sha!;
    const git = H.gitIn(repo, gpg);

    const raw = H.catFile(repo, gpg, c0, 'commit');
    const lines = raw.split('\n');
    const start = lines.findIndex((l) => l.startsWith('gpgsig '));
    T.check('fixture: root commit really is signed to begin with', start !== -1);
    let end = start + 1;
    while (end < lines.length && lines[end].startsWith(' ')) end++;
    const gpgsigBlock = lines.slice(start, end);
    const doubledLines = lines.slice(0, end).concat(gpgsigBlock, lines.slice(end));
    const doubled = doubledLines.join('\n');
    const hash = git(['hash-object', '-t', 'commit', '-w', '--literally', '--stdin'], { input: doubled });
    T.check('fixture: double-gpgsig commit object written', hash.status === 0, hash.stderr);
    const newOid = hash.stdout.trim();
    T.check('fixture: really has 2 gpgsig headers',
      (H.catFile(repo, gpg, newOid, 'commit').match(/^gpgsig /mg) || []).length === 2);
    git(['update-ref', 'refs/heads/main', newOid]);

    const policy = H.writePolicy('ac58-commit', { signingKey: gpg.fingerprint, timezone: 'UTC' });
    const out = H.runBin('git-sign', ['check', repo, '--range=refs/heads/main', '--policy=' + policy], { gnupgHome: gpg.gnupgHome });
    T.contains('AC-58.2: reports multiple-signatures for the commit, naming the block count',
      out.stdout, 'signature multiple-signatures (2 signature blocks found)');
    T.check('AC-58.2: does NOT also report it as missing/bad/etc', !/signature (missing|bad|signed by|good signature)/.test(out.stdout), out.stdout);
    T.exit('AC-58.2: exit 1 (a real violation)', out, 1);
  }
}

T.finish();
