/* AC-31 -- § 3.1/3.2: `replace` and `add-file` without --apply print
 * their per-commit "would change" report and a summary line, change no
 * ref, and exit 0. */
import fs from 'node:fs';
import path from 'node:path';
import * as H from '../lib/harness.ts';
const T = H.T;

H.requireBin('git-history-rewrite');

const gpg = H.setupGpg('ac31');
if (gpg) {
  const repo = H.initRepo('ac31', gpg);
  H.commit(repo, gpg, 'one', { 'a.txt': 'jdoe@internal.example\n' });
  H.commit(repo, gpg, 'two', { 'a.txt': 'nothing to change here\n' });

  const refsBefore = H.gitRaw(repo, gpg, ['show-ref']);
  const rulesFile = path.join(H.freshDir("ac31-rules"), "ac31-rules.txt");
  fs.writeFileSync(rulesFile, 'jdoe@internal.example\tREDACTED\n');

  const r = H.runBin('git-history-rewrite', ['replace', repo, '--rules', rulesFile], { gnupgHome: gpg.gnupgHome });
  T.exit('AC-31 replace (dry run): exit 0', r, 0);
  if (!r.missing) {
    T.contains('AC-31: per-commit "would change" line for the commit that actually changes', r.stdout, 'replace: ');
    T.contains('AC-31: per-commit line ends with "would change"', r.stdout, 'would change');
    T.contains('AC-31: summary line "N of M commits would change"', r.stdout, 'replace: 1 of 2 commits would change');
    T.contains('AC-31: dry-run line present', r.stdout, 'git-history-rewrite: dry run, no ref changed (use --apply to write)');
    const refsAfter = H.gitRaw(repo, gpg, ['show-ref']);
    T.eq('AC-31: no ref changed', refsAfter, refsBefore);
  }

  const srcFile = path.join(H.freshDir("ac31-addfile-src"), "ac31-addfile-src.txt");
  fs.writeFileSync(srcFile, 'content\n');
  const r2 = H.runBin('git-history-rewrite', ['add-file', repo, srcFile, '--as', 'NEWFILE'], { gnupgHome: gpg.gnupgHome });
  T.exit('AC-31 add-file (dry run): exit 0', r2, 0);
  if (!r2.missing) {
    T.contains('AC-31 add-file: per-commit line mentions adding NEWFILE', r2.stdout, 'would add/replace NEWFILE');
    T.contains('AC-31 add-file: dry-run line present', r2.stdout, 'git-history-rewrite: dry run, no ref changed (use --apply to write)');
    const refsAfter2 = H.gitRaw(repo, gpg, ['show-ref']);
    T.eq('AC-31 add-file: no ref changed', refsAfter2, refsBefore);
  }
}

T.finish();
