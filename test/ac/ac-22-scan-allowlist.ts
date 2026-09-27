/* AC-22 -- § 2.1: --allow <file> suppresses any hit whose exact match
 * string equals one of its lines, verbatim; other hits still print and
 * still count toward exit 1. */
import fs from 'node:fs';
import path from 'node:path';
import * as H from '../lib/harness.ts';
const T = H.T;

H.requireBin('git-leak-scan');

const gpg = H.setupGpg('ac22');
if (gpg) {
  const repo = H.initRepo('ac22', gpg);
  H.commit(repo, gpg, 'two emails, one known-good', {
    'a.txt': 'owner: jdoe@internal.example\nreporter: asmith@internal.example\n',
  });

  const allowFile = path.join(H.freshDir("ac22-allow"), "ac22-allow.txt");
  fs.writeFileSync(allowFile, '# known-good\njdoe@internal.example\n');

  const r = H.runBin('git-leak-scan', ['scan', repo, '--allow', allowFile], { gnupgHome: gpg.gnupgHome });
  T.exit('AC-22 scan --allow: one hit remains (the non-allowlisted email), exit 1', r, 1);
  if (!r.missing) {
    T.check('AC-22: the allowlisted email does NOT appear', !r.stdout.includes('jdoe@internal.example'), r.stdout);
    T.contains('AC-22: the other email still appears', r.stdout, 'asmith@internal.example');
  }

  /* Plus the fixture's own committer identity -- allowlisting just the
   * two planted emails would otherwise still leave H.FIXTURE_EMAIL as a
   * hit in every commit's identity line. */
  fs.writeFileSync(allowFile, 'jdoe@internal.example\nasmith@internal.example\n' + H.FIXTURE_EMAIL + '\n');
  const clean = H.runBin('git-leak-scan', ['scan', repo, '--allow', allowFile], { gnupgHome: gpg.gnupgHome });
  T.exit('AC-22: allowlisting both known matches makes the scan clean, exit 0', clean, 0);
}

T.finish();
