/* AC-62 -- `resign-commits`' root-inclusive form needs `--from-root`, and
 * its range errors and push hints (D17, docs audit #1/#4/#5/#15).
 *
 * A bare `<rev>` (no `..`) re-signs every ancestor down to the root plus
 * their descendants -- usually the whole history. `main` or `HEAD~3` reads
 * like "that commit" or "the last few", so the bare form is a usage error
 * (exit 2, nothing touched) unless `--from-root` says it is meant; the dry
 * run then names the count up front. Range-shape errors are usage errors
 * with one `git-sign:` prefix, not two. Push hints use the literal
 * `<remote>` placeholder (as resign-tags always did), and a ref whose sha
 * did not change gets none. */
import * as H from '../lib/harness.ts';
const T = H.T;

H.requireBin('git-sign');

function refsOf(repo: string, gpg: H.Gpg): string {
  return H.gitRaw(repo, gpg, ['for-each-ref', '--format=%(refname) %(objectname)']);
}

/* ---- 1: a bare <rev> without --from-root is a usage error, nothing touched */
{
  const gpg = H.setupGpg('ac62-bare');
  if (gpg) {
    const repo = H.initRepo('ac62-bare', gpg);
    const c0 = H.commit(repo, gpg, 'root', { 'a.txt': 'one\n' }, { date: '@1000000000 +0000' }).sha!;
    H.commit(repo, gpg, 'second', { 'b.txt': 'two\n' }, { date: '@1000000100 +0000' });
    H.commit(repo, gpg, 'third', { 'c.txt': 'three\n' }, { date: '@1000000200 +0000' });
    const policy = H.writePolicy('ac62-bare', { signingKey: gpg.fingerprint, timezone: 'UTC' });
    const refsBefore = refsOf(repo, gpg);
    const objsBefore = H.objectStoreSnapshot(repo, gpg);

    for (const rev of ['main', 'HEAD~1']) {
      for (const extra of [[], ['--apply']]) {
        const label = rev + (extra.length ? ' --apply' : '');
        const r = H.runBin('git-sign', ['resign-commits', repo, rev, ...extra, '--policy=' + policy], { gnupgHome: gpg.gnupgHome });
        T.exit('AC-62.1 ' + label + ': exit 2 (usage error)', r, 2);
        T.eq('AC-62.1 ' + label + ': the exact message', r.stderr,
          'git-sign: \'' + rev + '\' has no \'..\' -- that re-signs the whole history down to the root; ' +
          'pass --from-root if you mean that, or use <lower>..<upper>\n');
        T.eq('AC-62.1 ' + label + ': nothing on stdout', r.stdout, '');
      }
    }
    T.eq('AC-62.1: no ref moved', refsOf(repo, gpg), refsBefore);
    T.eq('AC-62.1: no object written', H.objectStoreDiff(objsBefore, H.objectStoreSnapshot(repo, gpg)).added.length, 0);

    /* --from-root: the dry run names the root-inclusive count first. */
    const dry = H.runBin('git-sign', ['resign-commits', repo, 'HEAD~1', '--from-root', '--policy=' + policy], { gnupgHome: gpg.gnupgHome });
    T.exit('AC-62.1 --from-root dry run: exit 0', dry, 0);
    const lines = dry.stdout.split('\n');
    T.eq('AC-62.1 --from-root dry run: first line is the root-inclusive count (3: HEAD~1, its root, and HEAD as a descendant)',
      lines[0], 'resign-commits: root-inclusive: 3 commits');
    T.contains('AC-62.1 --from-root dry run: lists the root', dry.stdout, c0.slice(0, 7) + ' would be re-signed');

    /* A `..` range never prints the root-inclusive line. */
    const ranged = H.runBin('git-sign', ['resign-commits', repo, c0 + '..main', '--policy=' + policy], { gnupgHome: gpg.gnupgHome });
    T.exit('AC-62.1 <lower>..<upper> dry run: exit 0', ranged, 0);
    T.check('AC-62.1 <lower>..<upper> dry run: no root-inclusive line', !ranged.stdout.includes('root-inclusive'), ranged.stdout);
  }
}

/* ---- 2: range-shape errors -- usage errors, one prefix ----------------- */
{
  const gpg = H.setupGpg('ac62-shape');
  if (gpg) {
    const repo = H.initRepo('ac62-shape', gpg);
    H.commit(repo, gpg, 'root', { 'a.txt': 'one\n' }, { date: '@1000000000 +0000' });
    H.commit(repo, gpg, 'second', { 'b.txt': 'two\n' }, { date: '@1000000100 +0000' });
    const policy = H.writePolicy('ac62-shape', { signingKey: gpg.fingerprint, timezone: 'UTC' });
    const cases: [string[], string][] = [
      [['main~1...main'], 'git-sign: <range> must be \'<lower>..<upper>\' (two dots, not three)\n'],
      [['main..'], 'git-sign: <range> must be \'<lower>..<upper>\'\n'],
      [['..main'], 'git-sign: <range> must be \'<lower>..<upper>\'\n'],
      [['main~1..main', '--from-root'], 'git-sign: --from-root takes a bare <rev>, not a range (\'main~1..main\')\n'],
    ];
    for (const [args, expected] of cases) {
      const r = H.runBin('git-sign', ['resign-commits', repo, ...args, '--policy=' + policy], { gnupgHome: gpg.gnupgHome });
      T.exit('AC-62.2 ' + args.join(' ') + ': exit 2', r, 2);
      T.eq('AC-62.2 ' + args.join(' ') + ': one prefix, exact text', r.stderr, expected);
    }
    /* Shape is checked before the repo/policy: a bad shape against a
     * missing policy is still the usage error, not a policy refusal. */
    const noPolicy = H.runBin('git-sign', ['resign-commits', repo, 'main', '--policy=/nonexistent/policy.json'], { gnupgHome: gpg.gnupgHome });
    T.exit('AC-62.2 bare <rev> + missing policy: still the usage error (exit 2)', noPolicy, 2);
    /* An unresolvable revision stays a refusal (exit 1). */
    const unresolved = H.runBin('git-sign', ['resign-commits', repo, 'nope..main', '--policy=' + policy], { gnupgHome: gpg.gnupgHome });
    T.exit('AC-62.2 unresolvable <lower>: refusal, exit 1', unresolved, 1);
    T.eq('AC-62.2 unresolvable <lower>: names the range', unresolved.stderr, 'git-sign: invalid revision range \'nope..main\'\n');
  }
}

/* ---- 3: push hints say <remote>; an unchanged sha gets none ------------- */
{
  const gpg = H.setupGpg('ac62-hints');
  if (gpg) {
    const repo = H.initRepo('ac62-hints', gpg);
    const c0 = H.commit(repo, gpg, 'root', { 'a.txt': 'one\n' }, { date: '@1000000000 +0000' }).sha!;
    H.commit(repo, gpg, 'second', { 'b.txt': 'two\n' }, { date: '@1000000100 +0000' });
    H.tagAnnotatedUnsigned(repo, gpg, 'v1', 'release one');
    const policy = H.writePolicy('ac62-hints', { signingKey: gpg.fingerprint, timezone: 'UTC' });
    const oldMain = H.revParse(repo, gpg, 'refs/heads/main');
    const oldTag = H.revParse(repo, gpg, 'refs/tags/v1');

    const first = H.runBin('git-sign', ['resign-commits', repo, c0 + '..main', '--apply', '--policy=' + policy], { gnupgHome: gpg.gnupgHome });
    T.exit('AC-62.3 first apply: exit 0', first, 0);
    T.contains('AC-62.3 first apply: branch hint names <remote>', first.stdout,
      '# git push --force-with-lease=main:' + oldMain + ' <remote> main\n');
    T.contains('AC-62.3 first apply: tag hint names <remote>', first.stdout,
      '# git push --force-with-lease=refs/tags/v1:' + oldTag + ' <remote> refs/tags/v1\n');
    T.check('AC-62.3 first apply: never assumes a remote called origin', !first.stdout.includes(' origin '), first.stdout);

    /* Again, same policy: ed25519 is deterministic and the signing time is
     * the same, so every new object is byte-identical to the one it
     * replaces -- nothing moved, nothing to push. */
    const mainAfterFirst = H.revParse(repo, gpg, 'refs/heads/main');
    const second = H.runBin('git-sign', ['resign-commits', repo, c0 + '..main', '--apply', '--policy=' + policy], { gnupgHome: gpg.gnupgHome });
    T.exit('AC-62.3 second apply: exit 0', second, 0);
    T.eq('AC-62.3 second apply: main did not move', H.revParse(repo, gpg, 'refs/heads/main'), mainAfterFirst);
    T.contains('AC-62.3 second apply: the commit is reported unchanged', second.stdout,
      mainAfterFirst.slice(0, 7) + ' -> ' + mainAfterFirst.slice(0, 7) + ' (unchanged)');
    T.check('AC-62.3 second apply: no push hint at all', !second.stdout.includes('# git push'), second.stdout);
  }
}

T.finish();
