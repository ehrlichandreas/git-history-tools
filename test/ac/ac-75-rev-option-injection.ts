/* AC-75 -- D20: a revision or range the caller gives is never read as a
 * git option. `git-sign check <repo> --range=--output=<file>` printed
 * "invalid revision range" and exited 1 -- and CREATED <file>: rev-list
 * took the range as its own `--output` option, so the "writes nothing,
 * ever" check (§ 5.4) wrote a file. Now every user-supplied revision
 * that reaches git (check's <range>, both ends of resign-commits'
 * <range>) is a usage error if it starts with `-`, checked before the
 * repo is read, and reaches git only after `--end-of-options`. The other
 * three tools take no revision from the caller. */
import fs from 'node:fs';
import path from 'node:path';
import * as H from '../lib/harness.ts';
const T = H.T;

H.requireBin('git-sign');

const gpg = H.setupGpg('ac75');
if (gpg) {
  const repo = H.initRepo('ac75', gpg);
  H.commit(repo, gpg, 'first', { 'a.txt': 'one\n' });
  H.commit(repo, gpg, 'second', { 'a.txt': 'two\n' });
  const policy = H.writePolicy('ac75', { signingKey: gpg.fingerprint });
  const out = H.freshDir('ac75-out');
  const target = path.join(out, 'injected.txt');
  const refsBefore = H.gitRaw(repo, gpg, ['for-each-ref']);
  const objectsBefore = H.objectStoreSnapshot(repo, gpg);
  const opts = { gnupgHome: gpg.gnupgHome };
  const P = '--policy=' + policy;

  const cases: [string, string[], string][] = [
    ['check --range=--output=<file>', ['check', repo, '--range=--output=' + target, P], '--output=' + target],
    ['check --range=-n1', ['check', repo, '--range=-n1', P], '-n1'],
    ['check <range> = -n1 (positional)', ['check', repo, '-n1', P], '-n1'],
    ['resign-commits -x..HEAD', ['resign-commits', repo, '-x..HEAD', P, '--apply'], '-x..HEAD'],
    ['resign-commits HEAD~1..--output=<file>', ['resign-commits', repo, 'HEAD~1..--output=' + target, P, '--apply'], 'HEAD~1..--output=' + target],
    ['resign-commits -x --from-root', ['resign-commits', repo, '-x', '--from-root', P, '--apply'], '-x'],
  ];
  for (const [label, args, range] of cases) {
    const r = H.runBin('git-sign', args, opts);
    T.exit('AC-75 [' + label + ']: usage error, exit 2', r, 2);
    T.eq('AC-75 [' + label + ']: one stderr line naming the range', r.stderr,
      'git-sign: <range> \'' + range + '\': a revision must not start with \'-\'\n');
    T.eq('AC-75 [' + label + ']: nothing on stdout', r.stdout, '');
    T.eq('AC-75 [' + label + ']: no file created', fs.existsSync(target), false);
    fs.rmSync(target, { force: true });
  }
  T.eq('AC-75: no ref moved', H.gitRaw(repo, gpg, ['for-each-ref']), refsBefore);
  T.eq('AC-75: no object written', JSON.stringify(H.objectStoreDiff(objectsBefore, H.objectStoreSnapshot(repo, gpg))),
    JSON.stringify({ added: [], removed: [], countChanged: false }));
  T.eq('AC-75: no backup bundle', H.findBackupBundle(repo), null);

  /* Ordinary ranges still work. */
  const ok = H.runBin('git-sign', ['check', repo, '--range=HEAD~1..HEAD', P], opts);
  T.check('AC-75: check HEAD~1..HEAD still runs (exit 0 or 1, a check line)', (ok.status === 0 || ok.status === 1) &&
    /^check: \d+ violation\(s\) across 1 commit\(s\)$/m.test(ok.stdout), ok.status + ' ' + ok.stdout + ok.stderr);
  const dry = H.runBin('git-sign', ['resign-commits', repo, 'HEAD~1..HEAD', P], opts);
  T.exit('AC-75: resign-commits HEAD~1..HEAD dry run still exits 0', dry, 0);
}

T.finish();
