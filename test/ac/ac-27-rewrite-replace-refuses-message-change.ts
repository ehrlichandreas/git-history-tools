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

T.finish();
