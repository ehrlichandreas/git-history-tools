/* AC-50 -- an unresolvable revision range given to `check` (e.g.
 * `<root>~1..HEAD`, since a root commit has no parent) is a refusal (exit
 * 1, one line naming it, nothing else on stdout) -- never an uncaught
 * GitError/Node stack trace. Found dogfooding: `check <nanojira>
 * v0.1~1..HEAD` crashed because v0.1 is the root commit. */
import * as H from '../lib/harness.ts';
const T = H.T;

H.requireBin('git-sign');

{
  const gpg = H.setupGpg('ac50-badrange');
  if (gpg) {
    const repo = H.initRepoNoSignConfig('ac50-badrange', gpg);
    H.commit(repo, gpg, 'root', { 'a.txt': 'one\n' }, { date: '@1000000000 +0000' });
    const root = H.revParse(repo, gpg, 'HEAD');
    const policy = H.writePolicy('ac50-badrange', { signingKey: gpg.fingerprint, timezone: 'UTC' });

    const badRange = root + '~1..HEAD';
    const out = H.runBin('git-sign', ['check', repo, badRange, '--policy=' + policy], { gnupgHome: gpg.gnupgHome });
    T.exit('AC-50: an unresolvable range is a refusal, exit 1', out, 1);
    T.eq('AC-50: nothing on stdout', out.stdout, '');
    T.contains('AC-50: stderr names the range', out.stderr, 'invalid revision range \'' + badRange + '\'');
    T.check('AC-50: no Node stack trace leaks to stderr', !out.stderr.includes('at ') && !out.stderr.includes('.ts:'), out.stderr);

    /* A garbage range (not even valid rev-list syntax) must behave the
     * same way, not just a numerically-impossible one. */
    const garbage = 'not-a-rev..also-not-a-rev';
    const out2 = H.runBin('git-sign', ['check', repo, garbage, '--policy=' + policy], { gnupgHome: gpg.gnupgHome });
    T.exit('AC-50: a nonsense range is also a refusal, exit 1', out2, 1);
    T.contains('AC-50: stderr names the nonsense range', out2.stderr, 'invalid revision range \'' + garbage + '\'');
  }
}

T.finish();
