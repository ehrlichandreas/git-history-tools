/* AC-29 -- § 4.4: --rules/--terms/--allow pointing INSIDE the target repo
 * is a hard refusal, exit 1, before any scan/rewrite work happens -- a
 * deliberate reading that overrides D1's looser "warns" prose (see
 * docs/SPECIFICATION.md § 4.4's decision note). */
import fs from 'node:fs';
import path from 'node:path';
import * as H from '../lib/harness.ts';
const T = H.T;

H.requireBin('git-history-rewrite');
H.requireBin('git-leak-scan');

const gpg = H.setupGpg('ac29');
if (gpg) {
  const repo = H.initRepo('ac29', gpg);
  H.commit(repo, gpg, 'root', { 'a.txt': 'clean\n' });

  const rulesInside = path.join(repo, 'rules.txt');
  fs.writeFileSync(rulesInside, 'from\tto\n');
  const replace = H.runBin('git-history-rewrite', ['replace', repo, '--rules', rulesInside], { gnupgHome: gpg.gnupgHome });
  T.exit('AC-29 replace: refuses a --rules path inside the repo', replace, 1);
  if (!replace.missing) {
    T.contains('AC-29 replace: refusal names --rules and the path', replace.stderr, '--rules points inside the repo');
    T.contains('AC-29 replace: refusal names the actual path', replace.stderr, rulesInside);
  }

  const termsInside = path.join(repo, 'terms.txt');
  fs.writeFileSync(termsInside, 'whatever\n');
  const scanTerms = H.runBin('git-leak-scan', ['scan', repo, '--terms', termsInside], { gnupgHome: gpg.gnupgHome });
  T.exit('AC-29 scan: refuses a --terms path inside the repo', scanTerms, 1);
  if (!scanTerms.missing) T.contains('AC-29 scan: refusal names --terms', scanTerms.stderr, '--terms points inside the repo');

  const allowInside = path.join(repo, 'allow.txt');
  fs.writeFileSync(allowInside, 'whatever\n');
  const scanAllow = H.runBin('git-leak-scan', ['scan', repo, '--allow', allowInside], { gnupgHome: gpg.gnupgHome });
  T.exit('AC-29 scan: refuses a --allow path inside the repo', scanAllow, 1);
  if (!scanAllow.missing) T.contains('AC-29 scan: refusal names --allow', scanAllow.stderr, '--allow points inside the repo');

  /* A symlink inside the repo pointing OUT to a real outside file must
   * still be caught -- the check resolves symlinks before comparing. */
  const outsideRules = path.join(H.freshDir("ac29-outside-rules"), "ac29-outside-rules.txt");
  fs.writeFileSync(outsideRules, 'from\tto\n');
  const linkPath = path.join(repo, 'rules-link.txt');
  try { fs.symlinkSync(outsideRules, linkPath); } catch (e) { /* unsupported fs, skip */ }
  if (fs.existsSync(linkPath)) {
    const viaLink = H.runBin('git-history-rewrite', ['replace', repo, '--rules', linkPath], { gnupgHome: gpg.gnupgHome });
    T.exit('AC-29: a symlink living inside the repo is refused even if its target is outside', viaLink, 1);
  }

  /* Bug fix regression: the reverse direction. A symlink living OUTSIDE
   * the repo whose target resolves INSIDE it used to be wrongly accepted
   * -- the old check only resolved symlinks in the given path's parent
   * directory, never the path's own final segment, so a symlink (itself
   * outside the repo) pointing at an in-repo file sailed through. Checked
   * both as a direct symlink and a 2-link chain. */
  const ruleTargetInside = path.join(repo, 'secret-rules.txt');
  fs.writeFileSync(ruleTargetInside, 'from\tto\n');

  const outsideDir = H.freshDir('ac29-outside-link');
  const directLink = path.join(outsideDir, 'direct-link.txt');
  try { fs.symlinkSync(ruleTargetInside, directLink); } catch (e) { /* unsupported fs, skip */ }
  if (fs.existsSync(directLink)) {
    const viaDirectLink = H.runBin('git-history-rewrite', ['replace', repo, '--rules', directLink], { gnupgHome: gpg.gnupgHome });
    T.exit('AC-29: a symlink living OUTSIDE the repo whose target resolves inside it is refused (direct link)', viaDirectLink, 1);
    if (!viaDirectLink.missing) T.contains('AC-29: refusal names --rules (direct link)', viaDirectLink.stderr, '--rules points inside the repo');
  }

  const chainLink = path.join(outsideDir, 'chain-link.txt');
  if (fs.existsSync(directLink)) {
    try { fs.symlinkSync(directLink, chainLink); } catch (e) { /* unsupported fs, skip */ }
  }
  if (fs.existsSync(chainLink)) {
    const viaChainLink = H.runBin('git-history-rewrite', ['replace', repo, '--rules', chainLink], { gnupgHome: gpg.gnupgHome });
    T.exit('AC-29: a 2-link symlink chain living OUTSIDE the repo whose final target resolves inside it is refused', viaChainLink, 1);
    if (!viaChainLink.missing) T.contains('AC-29: refusal names --rules (chain link)', viaChainLink.stderr, '--rules points inside the repo');
  }
}

T.finish();
