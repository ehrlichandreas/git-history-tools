'use strict';
/* AC-33 -- § 4.2 check 4: after `replace --apply`, the tool leak-scans
 * the RULES FILE'S OWN right-hand (replacement) values -- not the "from"
 * leaked terms, not the file's path -- and reports that check's line;
 * a chosen replacement that is itself another leak fails verification. */
const fs = require('fs');
const path = require('path');
const H = require('../lib/harness.js');
const T = H.T;

H.requireBin('ght-rewrite');

const gpg = H.setupGpg('ac33');
if (gpg) {
  const repo = H.initRepo('ac33', gpg);
  H.commit(repo, gpg, 'add leak', { 'a.txt': 'jdoe@internal.example\n' });

  const rulesFile = path.join(H.freshDir("ac33-rules-clean"), "ac33-rules-clean.txt");
  fs.writeFileSync(rulesFile, 'jdoe@internal.example\tREDACTED\n');

  const r = H.runBin('ght-rewrite', ['replace', repo, '--rules', rulesFile, '--apply'], { gnupgHome: gpg.gnupgHome });
  T.exit('AC-33 replace --apply with a clean replacement: exit 0', r, 0);
  if (!r.missing) T.contains('AC-33: the rule-sources-clean check reports OK', r.stdout, 'verify: replace: rule sources clean: OK');
}

const gpg2 = H.setupGpg('ac33b');
if (gpg2) {
  const repo2 = H.initRepo('ac33b', gpg2);
  H.commit(repo2, gpg2, 'add leak', { 'a.txt': 'jdoe@internal.example\n' });

  const rulesFile2 = path.join(H.freshDir("ac33-rules-still-leaky"), "ac33-rules-still-leaky.txt");
  /* The chosen replacement is itself another leaked email -- the
   * verification step must catch this, even though the "from" side
   * (jdoe@internal.example) is no longer in any blob after rewrite. */
  fs.writeFileSync(rulesFile2, 'jdoe@internal.example\tasmith@internal.example\n');

  const r2 = H.runBin('ght-rewrite', ['replace', repo2, '--rules', rulesFile2, '--apply'], { gnupgHome: gpg2.gnupgHome });
  T.exit('AC-33b: a rewrite whose replacement is itself a leak still writes (the write already happened) but exits 1', r2, 1);
  if (!r2.missing) {
    T.contains('AC-33b: the rule-sources-clean check reports FAILED', r2.stdout, 'verify: replace: rule sources clean: FAILED');
    T.contains('AC-33b: the failure names the leaked replacement value', r2.stdout, 'asmith@internal.example');
  }
}

T.finish();
