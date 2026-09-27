/* AC-24 -- § 3.1: `replace` rules apply in file order, each to the
 * OUTPUT of the previous rule -- a later rule can match text an earlier
 * rule just introduced. */
import fs from 'node:fs';
import path from 'node:path';
import * as H from '../lib/harness.ts';
const T = H.T;

H.requireBin('git-history-rewrite');

const gpg = H.setupGpg('ac24');
if (gpg) {
  const repo = H.initRepo('ac24', gpg);
  H.commit(repo, gpg, 'add file', { 'a.txt': 'alpha beta\n' });

  const rulesFile = path.join(H.freshDir("ac24-rules"), "ac24-rules.txt");
  /* Rule 1 turns "alpha" into "gamma"; rule 2 (relying on rule 1's own
   * output) turns "gamma beta" into "done" -- only reachable if rules
   * apply in order against the cumulative result, not all against the
   * original text independently. */
  fs.writeFileSync(rulesFile, 'alpha\tgamma\ngamma beta\tdone\n');

  const r = H.runBin('git-history-rewrite', ['replace', repo, '--rules', rulesFile, '--apply'], { gnupgHome: gpg.gnupgHome });
  T.exit('AC-24 replace --apply: exit 0', r, 0);
  if (!r.missing) {
    const headSha = H.revParse(repo, gpg, 'HEAD');
    const blob = H.catFile(repo, gpg, headSha + ':a.txt', '-p');
    T.eq('AC-24: the second rule fired against the first rule\'s own output', blob, 'done\n');
  }
}

T.finish();
