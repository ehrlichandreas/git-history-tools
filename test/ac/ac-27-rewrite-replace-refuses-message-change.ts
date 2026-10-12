/* AC-27 -- § 3.1: `replace` refuses, before writing anything, when
 * applying the rules to a commit MESSAGE would change its text --
 * replace only ever rewrites file contents. */
import fs from 'node:fs';
import path from 'node:path';
import * as H from '../lib/harness.ts';
const T = H.T;

H.requireBin('git-history-rewrite');

const gpg = H.setupGpg('ac27');
if (gpg) {
  const repo = H.initRepo('ac27', gpg);
  const c1 = H.commit(repo, gpg, 'commit mentions jdoe@internal.example in its own message',
    { 'a.txt': 'unrelated clean content\n' });
  const short = H.shortSha(repo, gpg, c1.sha!);
  const refsBefore = H.gitRaw(repo, gpg, ['show-ref']);

  const rulesFile = path.join(H.freshDir("ac27-rules"), "ac27-rules.txt");
  fs.writeFileSync(rulesFile, 'jdoe@internal.example\tREDACTED\n');

  const dry = H.runBin('git-history-rewrite', ['replace', repo, '--rules', rulesFile], { gnupgHome: gpg.gnupgHome });
  T.exit('AC-27 replace (dry run) refuses before even reporting a plan -- the message-would-change check runs up front', dry, 1);
  if (!dry.missing) {
    T.contains('AC-27: refusal names the commit and the reason', dry.stderr,
      'commit ' + short + ' message would change -- replace only rewrites file contents');
  }

  const applied = H.runBin('git-history-rewrite', ['replace', repo, '--rules', rulesFile, '--apply'], { gnupgHome: gpg.gnupgHome });
  T.exit('AC-27 replace --apply refuses too, repo left fully unchanged', applied, 1);
  if (!applied.missing) {
    const refsAfter = H.gitRaw(repo, gpg, ['show-ref']);
    T.eq('AC-27: every ref is byte-identical to before the refused attempt', refsAfter, refsBefore);
  }
}

/* Bug fix regression (same root cause as D4's verifySignatures() fix): a
 * commit reachable only via a stale refs/remotes/origin/<branch> ref --
 * never touched by replace/add-file, which only re-point refs/heads/
 * refs/tags -- must not cause a false-positive "message would change"
 * refusal for a branch whose own history has no such commit. Simulates a
 * clone that pushed a commit, then locally reset main back past it
 * (amend/reset), without updating its own remote-tracking ref. */
{
  const gpg = H.setupGpg('ac27-stale-ref');
  if (gpg) {
    const repo = H.initRepo('ac27-stale-ref', gpg);
    const c1 = H.commit(repo, gpg, 'clean root', { 'a.txt': 'unrelated clean content\n' });
    const c2 = H.commit(repo, gpg, 'commit mentions jdoe@internal.example in its own message',
      { 'a.txt': 'still clean\n' });
    const c2Short = H.shortSha(repo, gpg, c2.sha!);

    H.gitRaw(repo, gpg, ['update-ref', 'refs/remotes/origin/main', c2.sha!]);
    const git = H.gitIn(repo, gpg);
    const reset = git(['reset', '--hard', c1.sha!]);
    T.check('AC-27 (stale remote ref) fixture: reset main back to c1', reset.status === 0, reset.stderr);

    const rulesFile = path.join(H.freshDir("ac27-stale-ref-rules"), "ac27-stale-ref-rules.txt");
    fs.writeFileSync(rulesFile, 'jdoe@internal.example\tREDACTED\n');

    const r = H.runBin('git-history-rewrite', ['replace', repo, '--rules', rulesFile], { gnupgHome: gpg.gnupgHome });
    T.exit('AC-27 (stale remote ref): replace (dry run) succeeds -- the message-changing commit ' +
      'is only reachable via a stale refs/remotes ref, not main', r, 0);
    if (!r.missing) {
      T.contains('AC-27 (stale remote ref): reports 0 of 1 commits would change (only main\'s own history counted)',
        r.stdout, 'replace: 0 of 1 commits would change');
      T.check('AC-27 (stale remote ref): never mentions "message would change" or the orphaned commit\'s sha',
        !r.stderr.includes('message would change') && !r.stdout.includes(c2Short) && !r.stderr.includes(c2Short),
        'stdout: ' + r.stdout + ' stderr: ' + r.stderr);
    }
  }
}

T.finish();
