/* AC-64 -- git-sign's help/usage, the shared flag parser's missing-value
 * rule, and two message fixes (D17, docs audit #8/#15/#16/#17).
 *
 *   1. `--help`/`-h`/`help` print every subcommand's synopsis (exit 0,
 *      stdout); `<sub> --help` prints that one; a missing subcommand is
 *      exit 2 with the synopses after its error line, on stderr.
 *   2. A space-separated value that is itself a flag (`--message --apply`)
 *      is `missing value for --message`, exit 2, in every tool -- it used to
 *      be taken as the value, silently dropping the flag. `--flag=--x`
 *      still passes such a value explicitly.
 *   3. `tag`'s date refusals name "the target's" committer date (a tag has
 *      no parent); `commit`'s keep "the parent's".
 *   4. `resign-tags` on a tag whose re-signed object is byte-identical
 *      (ed25519, same signing time) reports it `(unchanged)` and prints no
 *      push hint. */
import fs from 'node:fs';
import path from 'node:path';
import * as H from '../lib/harness.ts';
const T = H.T;

H.requireBin('git-sign');

const SYNOPSES = [
  'git-sign commit <repo> (--message=<text>|--message-file=<path>) --date=(auto|<date>) [--amend] [--policy=<file>] [--apply]',
  'git-sign tag <repo> <tag> (--message=<text>|--message-file=<path>) --date=(auto|<date>) [--policy=<file>] [--apply]',
  'git-sign resign-tags <repo> [<tag> ...] [--policy=<file>] [--apply]',
  'git-sign resign-commits <repo> (<lower>..<upper> | <rev> --from-root) [--map-out=<file>] [--policy=<file>] [--apply]',
  'git-sign check <repo> [<range> | --range=<range>] [--tags] [--policy=<file>]',
];

/* ---- 1: help and usage ------------------------------------------------- */
{
  for (const word of ['--help', '-h', 'help']) {
    const r = H.runBin('git-sign', [word]);
    T.exit('AC-64.1 git-sign ' + word + ': exit 0', r, 0);
    for (const s of SYNOPSES) T.contains('AC-64.1 git-sign ' + word + ': lists ' + s.split(' ')[1], r.stdout, '  ' + s + '\n');
    T.eq('AC-64.1 git-sign ' + word + ': nothing on stderr', r.stderr, '');
  }
  const none = H.runBin('git-sign', []);
  T.exit('AC-64.1 no subcommand: exit 2', none, 2);
  T.check('AC-64.1 no subcommand: first stderr line names it (not \'undefined\')',
    none.stderr.startsWith('git-sign: missing subcommand\n'), none.stderr);
  for (const s of SYNOPSES) T.contains('AC-64.1 no subcommand: synopsis of ' + s.split(' ')[1], none.stderr, s);
  T.eq('AC-64.1 no subcommand: nothing on stdout', none.stdout, '');

  SYNOPSES.forEach((s) => {
    const sub = s.split(' ')[1];
    const r = H.runBin('git-sign', [sub, '--help']);
    T.exit('AC-64.1 git-sign ' + sub + ' --help: exit 0', r, 0);
    T.eq('AC-64.1 git-sign ' + sub + ' --help: exactly its own synopsis', r.stdout, 'usage: ' + s + '\n');
  });
  const unknown = H.runBin('git-sign', ['comit']);
  T.exit('AC-64.1 unknown subcommand: still exit 2', unknown, 2);
  T.eq('AC-64.1 unknown subcommand: still one line', unknown.stderr, 'git-sign: unknown subcommand \'comit\'\n');
}

/* ---- 2..4 need a repo and a key ---------------------------------------- */
{
  const gpg = H.setupGpg('ac64');
  if (gpg) {
    const repo = H.initRepo('ac64', gpg);
    H.commit(repo, gpg, 'root', { 'a.txt': 'one\n' }, { date: '@1000000000 +0000' });
    const policy = H.writePolicy('ac64', { signingKey: gpg.fingerprint, timezone: 'UTC' });
    const refs = () => H.gitRaw(repo, gpg, ['for-each-ref', '--format=%(refname) %(objectname)']);

    /* 2: missing value */
    const before = refs();
    const swallowed = H.runBin('git-sign', ['tag', repo, 't1', '--date=2001-09-09T03:00:00Z', '--message', '--apply', '--policy=' + policy],
      { gnupgHome: gpg.gnupgHome });
    T.exit('AC-64.2 tag --message --apply: exit 2', swallowed, 2);
    T.eq('AC-64.2 tag --message --apply: missing value', swallowed.stderr, 'git-sign: missing value for --message\n');
    T.eq('AC-64.2 tag --message --apply: no tag created', refs(), before);
    const explicit = H.runBin('git-sign', ['tag', repo, 't1', '--date=2001-09-09T03:00:00Z', '--message=--apply', '--policy=' + policy],
      { gnupgHome: gpg.gnupgHome });
    T.exit('AC-64.2 tag --message=--apply: accepted (a dry run with that message)', explicit, 0);
    const spaced = H.runBin('git-sign', ['tag', repo, 't1', '--date', '2001-09-09T03:00:00Z', '--message', 'plain', '--policy=' + policy],
      { gnupgHome: gpg.gnupgHome });
    T.exit('AC-64.2 space-separated values that are not flags still work', spaced, 0);
    const outside = H.freshDir('ac64-terms');
    const terms = path.join(outside, 'terms.txt');
    fs.writeFileSync(terms, 'secret\n');
    const scan = H.runBin('git-leak-scan', ['scan', repo, '--terms', '--allow', terms]);
    T.exit('AC-64.2 the shared parser: git-leak-scan --terms --allow is exit 2 too', scan, 2);
    T.eq('AC-64.2 git-leak-scan: missing value for --terms', scan.stderr, 'git-leak-scan: missing value for --terms\n');

    /* 3: target's vs parent's */
    const tagEarly = H.runBin('git-sign', ['tag', repo, 't2', '--message=m', '--date=2001-09-09T00:00:00Z', '--policy=' + policy],
      { gnupgHome: gpg.gnupgHome });
    T.exit('AC-64.3 tag dated before its target: refusal', tagEarly, 1);
    T.contains('AC-64.3 tag: names the target\'s committer date', tagEarly.stderr, 'is not after the target\'s committer date (');
    fs.writeFileSync(path.join(repo, 'b.txt'), 'two\n');
    H.gitIn(repo, gpg)(['add', 'b.txt']);
    const commitEarly = H.runBin('git-sign', ['commit', repo, '--message=m', '--date=2001-09-09T00:00:00Z', '--policy=' + policy],
      { gnupgHome: gpg.gnupgHome });
    T.exit('AC-64.3 commit dated before its parent: refusal', commitEarly, 1);
    T.contains('AC-64.3 commit: names the parent\'s committer date', commitEarly.stderr, 'is not after the parent\'s committer date (');

    /* 4: resign-tags, byte-identical result */
    const mk = H.runBin('git-sign', ['tag', repo, 'v1', '--message=one', '--date=2001-09-09T03:00:00Z', '--apply', '--policy=' + policy],
      { gnupgHome: gpg.gnupgHome });
    T.exit('AC-64.4 fixture: a policy-signed tag', mk, 0);
    const oldSha = H.revParse(repo, gpg, 'refs/tags/v1');
    const rt = H.runBin('git-sign', ['resign-tags', repo, 'v1', '--apply', '--policy=' + policy], { gnupgHome: gpg.gnupgHome });
    T.exit('AC-64.4 resign-tags v1 --apply: exit 0', rt, 0);
    T.eq('AC-64.4 the tag object is byte-identical', H.revParse(repo, gpg, 'refs/tags/v1'), oldSha);
    T.contains('AC-64.4 reported as unchanged', rt.stdout, 'resign-tags: v1 ' + oldSha + ' -> ' + oldSha + ' (unchanged)\n');
    T.check('AC-64.4 no push hint for it', !rt.stdout.includes('# git push'), rt.stdout);
  }
}

T.finish();
