/* AC-47 -- § 5.4 `check`: read-only; a clean range is exit 0 with no
 * output; identity/signature/forbidden-window/forbidden-message violations
 * are each a named `<sha> <rule> <detail>` line and exit 1 (the deliberate
 * exception to "nothing on stdout on exit 1", since the violation lines
 * are the whole point); no upstream configured is a refusal (exit 1,
 * nothing on stdout) unless --range is given explicitly; --tags extends
 * the same checks to every annotated tag. */
import * as H from '../lib/harness.ts';
const T = H.T;

H.requireBin('git-sign');

{
  const gpg = H.setupGpg('ac47-clean');
  if (gpg) {
    const repo = H.initRepoNoSignConfig('ac47-clean', gpg);
    const upstream = H.initRepoNoSignConfig('ac47-upstream', gpg);
    H.commit(upstream, gpg, 'root', { 'a.txt': 'one\n' }, { date: '@1000000000 +0000' });

    const policy = H.writePolicy('ac47-clean', { signingKey: gpg.fingerprint, timezone: 'UTC' });

    /* No upstream at all -- refused, nothing on stdout. */
    const noUpstream = H.runBin('git-sign', ['check', repo, '--policy=' + policy], { gnupgHome: gpg.gnupgHome });
    T.exit('AC-47: no upstream configured is a refusal, exit 1', noUpstream, 1);
    T.eq('AC-47: no upstream: nothing on stdout', noUpstream.stdout, '');
    T.contains('AC-47: no upstream: mentions --range', noUpstream.stderr, '--range');

    /* An --apply via git-sign, using the policy identity/key and a date
     * well outside any forbidden window, naturally produces a clean commit. */
    H.gitIn(repo, gpg)(['remote', 'add', 'origin', upstream]);
    H.gitIn(repo, gpg)(['fetch', '-q', 'origin']);
    H.gitIn(repo, gpg)(['checkout', '-q', '-b', 'main', 'origin/main']);
    const r = H.runBin('git-sign',
      ['commit', repo, '--amend', '--message=root', '--date=2001-09-10T01:46:40Z', '--policy=' + policy, '--apply'],
      { gnupgHome: gpg.gnupgHome });
    T.exit('fixture: git-sign commit --amend --apply succeeds', r, 0);
    H.gitIn(repo, gpg)(['branch', '--set-upstream-to=origin/main', 'main']);

    const clean = H.runBin('git-sign', ['check', repo, '--policy=' + policy], { gnupgHome: gpg.gnupgHome });
    T.exit('AC-47: a clean range is exit 0', clean, 0);
    T.contains('AC-47: a clean range reports 0 violations', clean.stdout, 'check: 0 violation(s)');
  }
}

{
  const gpg = H.setupGpg('ac47-violations');
  if (gpg) {
    const repo = H.initRepoNoSignConfig('ac47-violations', gpg);
    H.commit(repo, gpg, 'wrong identity, unsigned, forbidden message', { 'a.txt': 'one\n' },
      { date: '@' + Math.floor(new Date('2026-10-15T12:00:00Z').getTime() / 1000) + ' +0000' });
    const sha = H.shortSha(repo, gpg, 'HEAD');

    const policy = H.writePolicy('ac47-violations', {
      identity: { name: 'Policy Person', email: 'policy@example.invalid' },
      signingKey: gpg.fingerprint,
      timezone: 'UTC',
      forbiddenWindows: [{ days: ['mon', 'tue', 'wed', 'thu', 'fri'], from: '07:00', to: '19:00' }],
      forbiddenMessagePatterns: ['unsigned'],
    });

    const r = H.runBin('git-sign', ['check', repo, '--range=HEAD', '--policy=' + policy], { gnupgHome: gpg.gnupgHome });
    T.exit('AC-47 violations: exit 1', r, 1);
    T.contains('AC-47 violations: identity violation names the commit', r.stdout, sha + ' identity');
    T.contains('AC-47 violations: signature violation (unsigned commit)', r.stdout, sha + ' signature');
    T.contains('AC-47 violations: date violation (forbidden window)', r.stdout, sha + ' date');
    T.contains('AC-47 violations: message violation names the pattern', r.stdout, sha + ' message matches forbidden pattern: unsigned');
    T.contains('AC-47 violations: a summary line with a nonzero count', r.stdout, 'violation(s) across 1 commit(s)');
  }
}

{
  const gpg = H.setupGpg('ac47-tags');
  if (gpg) {
    const repo = H.initRepoNoSignConfig('ac47-tags', gpg);
    H.commit(repo, gpg, 'root', { 'a.txt': 'one\n' }, { date: '@1000000000 +0000' });
    H.tagAnnotatedUnsigned(repo, gpg, 'v-bad', 'release notes');
    const policy = H.writePolicy('ac47-tags', { signingKey: gpg.fingerprint, timezone: 'UTC' });

    const withoutTags = H.runBin('git-sign', ['check', repo, '--range=HEAD', '--policy=' + policy], { gnupgHome: gpg.gnupgHome });
    T.check('AC-47 --tags: omitted, v-bad is never mentioned', !withoutTags.stdout.includes('v-bad'));

    const withTags = H.runBin('git-sign', ['check', repo, '--range=HEAD', '--tags', '--policy=' + policy], { gnupgHome: gpg.gnupgHome });
    T.exit('AC-47 --tags: exit 1 (v-bad is unsigned)', withTags, 1);
    T.contains('AC-47 --tags: v-bad signature violation', withTags.stdout, 'v-bad signature');
    T.contains('AC-47 --tags: summary mentions the tag count', withTags.stdout, 'and 1 tag(s)');
  }
}

T.finish();
