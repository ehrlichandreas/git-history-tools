/* AC-63 -- git-sign takes its gpg binary from the policy, never from git
 * config (D17, docs audit #3).
 *
 * `gpg.program` in the repo's (or any) git config is ignored by every
 * git-sign command -- including the gpg that `git verify-commit`/
 * `verify-tag`/`tag -v` run on git-sign's behalf. The optional policy key
 * `gpgProgram` (an absolute path to an executable file) names it instead;
 * without it, `gpg` from PATH. Fixture: a "trap" program that records
 * every call in a log file and then fails, set as the repo's gpg.program,
 * and a "logging" wrapper that records and then execs the real gpg, set
 * as the policy's gpgProgram. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as H from '../lib/harness.ts';
const T = H.T;

H.requireBin('git-sign');

function script(label: string, body: string): { prog: string; log: string } {
  const dir = H.freshDir('ac63-' + label);
  const prog = path.join(dir, 'gpg-' + label + '.sh');
  const log = path.join(dir, 'calls.log');
  fs.writeFileSync(prog, '#!/bin/sh\necho "$*" >> ' + JSON.stringify(log) + '\n' + body);
  fs.chmodSync(prog, 0o755);
  return { prog, log };
}
const callCount = (log: string) => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).length : 0);

{
  const gpg = H.setupGpg('ac63');
  if (gpg) {
    const repo = H.initRepo('ac63', gpg);
    H.commit(repo, gpg, 'root', { 'a.txt': 'one\n' }, { date: '@1000000000 +0000' });
    const trap = script('trap', 'exit 1\n');
    const logging = script('logging', 'exec gpg "$@"\n');
    H.gitIn(repo, gpg)(['config', 'gpg.program', trap.prog]);

    /* 1: no gpgProgram key -- `gpg` from PATH; the repo's gpg.program is never run. */
    const plain = H.writePolicy('ac63-plain', { signingKey: gpg.fingerprint, timezone: 'UTC' });
    const chk = H.runBin('git-sign', ['check', repo, 'main', '--policy=' + plain], { gnupgHome: gpg.gnupgHome });
    T.exit('AC-63.1 check, repo gpg.program = trap: exit 0 (clean)', chk, 0);
    fs.writeFileSync(path.join(repo, 'b.txt'), 'two\n');
    H.gitIn(repo, gpg)(['add', 'b.txt']);
    const commit = H.runBin('git-sign', ['commit', repo, '--message=second', '--date=2001-09-09T03:00:00Z', '--apply', '--policy=' + plain],
      { gnupgHome: gpg.gnupgHome });
    T.exit('AC-63.1 commit --apply, repo gpg.program = trap: exit 0', commit, 0);
    T.check('AC-63.1 the new commit verifies', H.gitIn(repo, gpg)(['-c', 'gpg.program=gpg', 'verify-commit', 'HEAD']).status === 0);
    const resign = H.runBin('git-sign', ['resign-commits', repo, 'main', '--from-root', '--apply', '--policy=' + plain],
      { gnupgHome: gpg.gnupgHome });
    T.exit('AC-63.1 resign-commits --apply (verify lines run git verify-commit): exit 0', resign, 0);
    T.eq('AC-63.1 the repo\'s gpg.program was never run', callCount(trap.log), 0);

    /* 2: gpgProgram set -- every gpg call goes through it. */
    const viaPolicy = H.writePolicy('ac63-logging', { signingKey: gpg.fingerprint, timezone: 'UTC', gpgProgram: logging.prog });
    const chk2 = H.runBin('git-sign', ['check', repo, 'main', '--policy=' + viaPolicy], { gnupgHome: gpg.gnupgHome });
    T.exit('AC-63.2 check via the policy\'s gpgProgram: exit 0', chk2, 0);
    const afterCheck = callCount(logging.log);
    T.check('AC-63.2 check ran the policy\'s gpgProgram', afterCheck > 0, String(afterCheck));
    T.check('AC-63.2 including for git verify-commit (--status-fd/--verify)',
      fs.readFileSync(logging.log, 'utf8').includes('--verify'), fs.readFileSync(logging.log, 'utf8'));
    H.tagAnnotatedUnsigned(repo, gpg, 'v1', 'one');
    const rt = H.runBin('git-sign', ['resign-tags', repo, '--apply', '--policy=' + viaPolicy], { gnupgHome: gpg.gnupgHome });
    T.exit('AC-63.2 resign-tags --apply via gpgProgram: exit 0', rt, 0);
    T.contains('AC-63.2 resign-tags verify passes', rt.stdout, 'verify: v1: OK');
    T.check('AC-63.2 resign-tags signed through it too', callCount(logging.log) > afterCheck);
    T.eq('AC-63.2 the repo\'s gpg.program still never ran', callCount(trap.log), 0);

    /* 3: validation -- each a refusal naming the problem. */
    const notExec = script('noexec', 'exec gpg "$@"\n');
    fs.chmodSync(notExec.prog, 0o644);
    const bad: [string, unknown, string][] = [
      ['relative path', 'gpg', '\'gpgProgram\' must be an absolute path (got "gpg")'],
      ['not a string', 42, '\'gpgProgram\' must be an absolute path (got 42)'],
      ['missing file', '/nonexistent/ght-gpg', '\'gpgProgram\' does not exist: /nonexistent/ght-gpg'],
      ['a directory', os.tmpdir(), '\'gpgProgram\' is not a file: ' + os.tmpdir()],
      ['not executable', notExec.prog, '\'gpgProgram\' is not executable: ' + notExec.prog],
    ];
    for (const [label, value, msg] of bad) {
      const file = H.writePolicy('ac63-bad', { signingKey: gpg.fingerprint, timezone: 'UTC' });
      const json = JSON.parse(fs.readFileSync(file, 'utf8'));
      json.gpgProgram = value;
      fs.writeFileSync(file, JSON.stringify(json));
      const r = H.runBin('git-sign', ['check', repo, 'main', '--policy=' + file], { gnupgHome: gpg.gnupgHome });
      T.exit('AC-63.3 gpgProgram ' + label + ': refusal, exit 1', r, 1);
      T.eq('AC-63.3 gpgProgram ' + label + ': names the problem', r.stderr, 'git-sign: policy ' + file + ': ' + msg + '\n');
      T.eq('AC-63.3 gpgProgram ' + label + ': nothing on stdout', r.stdout, '');
    }
  }
}

T.finish();
