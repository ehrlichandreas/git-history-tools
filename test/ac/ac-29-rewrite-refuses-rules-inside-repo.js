'use strict';
/* AC-29 -- § 4.4: --rules/--terms/--allow pointing INSIDE the target repo
 * is a hard refusal, exit 1, before any scan/rewrite work happens -- a
 * deliberate reading that overrides D1's looser "warns" prose (see
 * docs/SPECIFICATION.md § 4.4's decision note). */
const fs = require('fs');
const path = require('path');
const H = require('../lib/harness.js');
const T = H.T;

H.requireBin('ght-rewrite');
H.requireBin('ght-scan');

const gpg = H.setupGpg('ac29');
if (gpg) {
  const repo = H.initRepo('ac29', gpg);
  H.commit(repo, gpg, 'root', { 'a.txt': 'clean\n' });

  const rulesInside = path.join(repo, 'rules.txt');
  fs.writeFileSync(rulesInside, 'from\tto\n');
  const replace = H.runBin('ght-rewrite', ['replace', repo, '--rules', rulesInside], { gnupgHome: gpg.gnupgHome });
  T.exit('AC-29 replace: refuses a --rules path inside the repo', replace, 1);
  if (!replace.missing) {
    T.contains('AC-29 replace: refusal names --rules and the path', replace.stderr, '--rules points inside the repo');
    T.contains('AC-29 replace: refusal names the actual path', replace.stderr, rulesInside);
  }

  const termsInside = path.join(repo, 'terms.txt');
  fs.writeFileSync(termsInside, 'whatever\n');
  const scanTerms = H.runBin('ght-scan', ['scan', repo, '--terms', termsInside], { gnupgHome: gpg.gnupgHome });
  T.exit('AC-29 scan: refuses a --terms path inside the repo', scanTerms, 1);
  if (!scanTerms.missing) T.contains('AC-29 scan: refusal names --terms', scanTerms.stderr, '--terms points inside the repo');

  const allowInside = path.join(repo, 'allow.txt');
  fs.writeFileSync(allowInside, 'whatever\n');
  const scanAllow = H.runBin('ght-scan', ['scan', repo, '--allow', allowInside], { gnupgHome: gpg.gnupgHome });
  T.exit('AC-29 scan: refuses a --allow path inside the repo', scanAllow, 1);
  if (!scanAllow.missing) T.contains('AC-29 scan: refusal names --allow', scanAllow.stderr, '--allow points inside the repo');

  /* A symlink inside the repo pointing OUT to a real outside file must
   * still be caught -- the check resolves symlinks before comparing. */
  const outsideRules = path.join(H.freshDir("ac29-outside-rules"), "ac29-outside-rules.txt");
  fs.writeFileSync(outsideRules, 'from\tto\n');
  const linkPath = path.join(repo, 'rules-link.txt');
  try { fs.symlinkSync(outsideRules, linkPath); } catch (e) { /* unsupported fs, skip */ }
  if (fs.existsSync(linkPath)) {
    const viaLink = H.runBin('ght-rewrite', ['replace', repo, '--rules', linkPath], { gnupgHome: gpg.gnupgHome });
    T.exit('AC-29: a symlink living inside the repo is refused even if its target is outside', viaLink, 1);
  }
}

T.finish();
