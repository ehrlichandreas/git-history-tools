/* AC-26 -- § 3.1: a text file with no trailing newline keeps having none
 * after replace runs, even when a rule's replacement is the very last
 * thing in the file. */
import fs from 'node:fs';
import path from 'node:path';
import * as H from '../lib/harness.ts';
const T = H.T;

H.requireBin('git-history-rewrite');

const gpg = H.setupGpg('ac26');
if (gpg) {
  const repo = H.initRepo('ac26', gpg);
  H.commit(repo, gpg, 'file with no trailing newline', { 'a.txt': 'hello jdoe@internal.example' });

  const rulesFile = path.join(H.freshDir("ac26-rules"), "ac26-rules.txt");
  fs.writeFileSync(rulesFile, 'jdoe@internal.example\tREDACTED\n');

  const r = H.runBin('git-history-rewrite', ['replace', repo, '--rules', rulesFile, '--apply'], { gnupgHome: gpg.gnupgHome });
  T.exit('AC-26 replace --apply: exit 0', r, 0);
  if (!r.missing) {
    const headSha = H.revParse(repo, gpg, 'HEAD');
    const blob = H.catFile(repo, gpg, headSha + ':a.txt', '-p');
    T.eq('AC-26: content is replaced', blob, 'hello REDACTED');
    T.check('AC-26: still no trailing newline', !blob.endsWith('\n'), JSON.stringify(blob));
  }
}

T.finish();
