/* AC-42 -- § 5.1 `commit`: dry run prints resolved identity/date/key/
 * signature time and writes nothing; --apply creates a signed commit whose
 * author/committer identity and date come from the policy and --date, never
 * from the repo's own git config (the fixture repo carries none); a
 * forbidden-pattern message and a forbidden-window date are both refused,
 * repo left untouched either way. */
import fs from 'node:fs';
import path from 'node:path';
import * as H from '../lib/harness.ts';
const T = H.T;

H.requireBin('git-sign');

function identLine(repo: string, gpg: H.Gpg, rev: string, field: string): string {
  const raw = H.catFile(repo, gpg, rev, '-p');
  const m = new RegExp('^' + field + ' (.*) (\\d+) ([+-]\\d{4})$', 'm').exec(raw);
  return m ? m[1] + '|' + m[2] + '|' + m[3] : '';
}

/** `.git/config`'s own raw bytes -- D8's core guarantee is that git-sign
 * never persists identity/key there, only ever passing them via env vars
 * and one-shot `-c` overrides. A byte-identical snapshot before/after is
 * the regression guard for that guarantee, the same way objectStoreSnapshot
 * guards D2. */
function gitConfigBytes(repo: string): Buffer {
  return fs.readFileSync(path.join(repo, '.git', 'config'));
}

{
  const gpg = H.setupGpg('ac42-basic');
  if (gpg) {
    const repo = H.initRepoNoSignConfig('ac42-basic', gpg);
    H.commit(repo, gpg, 'root', { 'a.txt': 'one\n' }, { date: '@1000000000 +0000' });
    const policy = H.writePolicy('ac42-basic', {
      identity: { name: 'Policy Person', email: 'policy@example.invalid' },
      signingKey: gpg.fingerprint,
      timezone: 'UTC',
    });

    const dry = H.runBin('git-sign',
      ['commit', repo, '--message=a real change', '--date=2001-09-10T01:46:40Z', '--policy=' + policy],
      { gnupgHome: gpg.gnupgHome });
    T.exit('AC-42 dry run: exit 0', dry, 0);
    T.contains('AC-42 dry run: reports the policy identity', dry.stdout, 'Policy Person <policy@example.invalid>');
    T.contains('AC-42 dry run: reports the resolved date', dry.stdout, '2001-09-10');
    T.contains('AC-42 dry run: reports the policy key', dry.stdout, gpg.fingerprint);
    T.contains('AC-42 dry run: says nothing committed', dry.stdout, 'dry run, nothing committed');

    const before = H.revParse(repo, gpg, 'HEAD');
    const beforeSnap = H.objectStoreSnapshot(repo, gpg);
    const dryAgain = H.runBin('git-sign',
      ['commit', repo, '--message=a real change', '--date=2001-09-10T01:46:40Z', '--policy=' + policy],
      { gnupgHome: gpg.gnupgHome });
    T.exit('AC-42 dry run (repeat): exit 0', dryAgain, 0);
    T.eq('AC-42 dry run: HEAD unchanged', H.revParse(repo, gpg, 'HEAD'), before);
    const afterSnap = H.objectStoreSnapshot(repo, gpg);
    T.eq('AC-42 dry run: no new objects written', H.objectStoreDiff(beforeSnap, afterSnap).added, []);

    fs.writeFileSync(path.join(repo, 'b.txt'), 'two\n');
    H.gitIn(repo, gpg)(['add', '-A']);
    const configBefore = gitConfigBytes(repo);
    const apply = H.runBin('git-sign',
      ['commit', repo, '--message=a real change', '--date=2001-09-10T01:46:40Z', '--policy=' + policy, '--apply'],
      { gnupgHome: gpg.gnupgHome });
    T.exit('AC-42 apply: exit 0', apply, 0);
    T.check('AC-42 apply: .git/config is byte-identical (D8, no persisted identity/key)', gitConfigBytes(repo).equals(configBefore));
    const newHead = H.revParse(repo, gpg, 'HEAD');
    T.check('AC-42 apply: HEAD moved', newHead !== before);
    const author = identLine(repo, gpg, 'HEAD', 'author');
    const committer = identLine(repo, gpg, 'HEAD', 'committer');
    T.eq('AC-42 apply: author identity/date/offset from policy and --date', author, 'Policy Person <policy@example.invalid>|1000086400|+0000');
    T.eq('AC-42 apply: committer identity/date/offset == author', committer, author);
    const verify = H.gitIn(repo, gpg)(['verify-commit', 'HEAD']);
    T.check('AC-42 apply: new commit has a valid signature', verify.status === 0, verify.stderr);

    /* "strictly after": a --date EQUAL to the parent's own committer date
     * (1000086400, HEAD's date after the apply above) is refused, not just
     * one strictly before it. A real staged change makes sure a refusal
     * here can only be the date check -- not "nothing to commit". */
    fs.writeFileSync(path.join(repo, 'c.txt'), 'three\n');
    H.gitIn(repo, gpg)(['add', '-A']);
    const headBefore = H.revParse(repo, gpg, 'HEAD');
    const equalDate = H.runBin('git-sign',
      ['commit', repo, '--message=another change', '--date=2001-09-10T01:46:40Z', '--policy=' + policy, '--apply'],
      { gnupgHome: gpg.gnupgHome });
    T.exit('AC-42 apply: a --date EQUAL to the parent\'s committer date is refused', equalDate, 1);
    T.eq('AC-42 apply: HEAD unchanged after the equal-date refusal', H.revParse(repo, gpg, 'HEAD'), headBefore);
  }
}

/* ---- forbidden message pattern -------------------------------------- */
{
  const gpg = H.setupGpg('ac42-pattern');
  if (gpg) {
    const repo = H.initRepoNoSignConfig('ac42-pattern', gpg);
    H.commit(repo, gpg, 'root', { 'a.txt': 'one\n' }, { date: '@1000000000 +0000' });
    const policy = H.writePolicy('ac42-pattern', {
      signingKey: gpg.fingerprint,
      timezone: 'UTC',
      forbiddenMessagePatterns: ['Co-Authored-By: Claude'],
    });
    const before = H.revParse(repo, gpg, 'HEAD');

    const r = H.runBin('git-sign',
      ['commit', repo, '--message=fix: thing\n\nCo-Authored-By: Claude <noreply@anthropic.com>', '--date=2001-09-10T01:46:40Z',
        '--policy=' + policy, '--apply'],
      { gnupgHome: gpg.gnupgHome });
    T.exit('AC-42 forbidden message: refusal, exit 1', r, 1);
    T.contains('AC-42 forbidden message: names the pattern', r.stderr, 'Co-Authored-By: Claude');
    T.eq('AC-42 forbidden message: HEAD unchanged', H.revParse(repo, gpg, 'HEAD'), before);
  }
}

/* ---- forbidden window date ------------------------------------------- */
{
  const gpg = H.setupGpg('ac42-window');
  if (gpg) {
    const repo = H.initRepoNoSignConfig('ac42-window', gpg);
    H.commit(repo, gpg, 'root', { 'a.txt': 'one\n' }, { date: '@1000000000 +0000' });
    const policy = H.writePolicy('ac42-window', {
      signingKey: gpg.fingerprint,
      timezone: 'UTC',
      forbiddenWindows: [{ days: ['mon', 'tue', 'wed', 'thu', 'fri'], from: '07:00', to: '19:00' }],
    });
    const before = H.revParse(repo, gpg, 'HEAD');

    /* 2026-10-15 is a Thursday; 12:00 UTC falls inside the window above. */
    const r = H.runBin('git-sign',
      ['commit', repo, '--message=a real change', '--date=2026-10-15T12:00:00Z', '--policy=' + policy, '--apply'],
      { gnupgHome: gpg.gnupgHome });
    T.exit('AC-42 forbidden window: refusal, exit 1', r, 1);
    T.contains('AC-42 forbidden window: names the window', r.stderr, 'forbidden window');
    T.eq('AC-42 forbidden window: HEAD unchanged', H.revParse(repo, gpg, 'HEAD'), before);
  }
}

/* ---- missing --date: usage error, nothing written ------------------- */
{
  const gpg = H.setupGpg('ac42-nodate');
  if (gpg) {
    const repo = H.initRepoNoSignConfig('ac42-nodate', gpg);
    H.commit(repo, gpg, 'root', { 'a.txt': 'one\n' }, { date: '@1000000000 +0000' });
    const policy = H.writePolicy('ac42-nodate', { signingKey: gpg.fingerprint, timezone: 'UTC' });
    const before = H.revParse(repo, gpg, 'HEAD');

    const r = H.runBin('git-sign',
      ['commit', repo, '--message=x', '--policy=' + policy, '--apply'],
      { gnupgHome: gpg.gnupgHome });
    T.exit('AC-42 missing --date: usage error, exit 2', r, 2);
    T.contains('AC-42 missing --date: names the problem', r.stderr, 'missing --date');
    T.eq('AC-42 missing --date: nothing on stdout', r.stdout, '');
    T.eq('AC-42 missing --date: HEAD unchanged', H.revParse(repo, gpg, 'HEAD'), before);
  }
}

T.finish();
