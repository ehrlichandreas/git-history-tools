/* AC-21 -- § 2.1: --terms <file> adds the user's own case-insensitive
 * literal terms as an extra category "term", one per non-blank/non-#
 * line of the terms file. */
import fs from 'node:fs';
import path from 'node:path';
import * as H from '../lib/harness.ts';
const T = H.T;

H.requireBin('git-leak-scan');

const gpg = H.setupGpg('ac21');
if (gpg) {
  const repo = H.initRepo('ac21', gpg);
  const c1 = H.commit(repo, gpg, 'mentions the internal project code name', {
    'notes.txt': 'The project is internally called Secret-Corp Falcon.\n',
  });

  const termsFile = path.join(H.freshDir("ac21-terms"), "ac21-terms.txt");
  fs.writeFileSync(termsFile, '# comment, skipped\n\nsecret-corp\n');
  /* The fixture's own committer identity is itself email-shaped and
   * would otherwise make even the "without --terms" scan non-clean --
   * allowlist it so this file tests the project-name string, not an
   * artifact of the fixture's throwaway identity. */
  const allowFile = path.join(H.freshDir("ac21-allow"), "ac21-allow.txt");
  fs.writeFileSync(allowFile, H.FIXTURE_EMAIL + '\n');

  const withoutTerms = H.runBin('git-leak-scan', ['scan', repo, '--allow', allowFile], { gnupgHome: gpg.gnupgHome });
  T.exit('AC-21: without --terms, the plain project-name string is not flagged by the built-ins, exit 0', withoutTerms, 0);

  const withTerms = H.runBin('git-leak-scan', ['scan', repo, '--terms', termsFile, '--allow', allowFile], { gnupgHome: gpg.gnupgHome });
  T.exit('AC-21: with --terms, the same scan now finds the term, exit 1', withTerms, 1);
  if (!withTerms.missing) {
    T.contains('AC-21: hit is reported under category "term", case-insensitively matched',
      withTerms.stdout, 'scan: term Secret-Corp (1) first at');
  }
}

T.finish();
