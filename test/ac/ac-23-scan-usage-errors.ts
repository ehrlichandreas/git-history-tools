/* AC-23 -- § 0 / § 2.1: a usage mistake (bad flag, a --terms/--allow file
 * that does not exist) is exit 2, distinct from exit 1's "clean scan
 * found hits" meaning. */
import path from 'node:path';
import * as H from '../lib/harness.ts';
const T = H.T;

H.requireBin('leak-scan');

const gpg = H.setupGpg('ac23');
if (gpg) {
  const repo = H.initRepo('ac23', gpg);
  H.commit(repo, gpg, 'clean', { 'a.txt': 'nothing sensitive\n' });

  const badFlag = H.runBin('leak-scan', ['scan', repo, '--bogus-flag'], { gnupgHome: gpg.gnupgHome });
  T.exit('AC-23: an unknown flag is a usage error, exit 2', badFlag, 2);
  if (!badFlag.missing) T.eq('AC-23: nothing on stdout for a usage error', badFlag.stdout, '');

  const missingTerms = H.runBin('leak-scan', ['scan', repo, '--terms', path.join(H.freshDir("ac23-does-not-exist"), "ac23-does-not-exist.txt")], { gnupgHome: gpg.gnupgHome });
  T.exit('AC-23: a --terms file that does not exist is a usage error, exit 2', missingTerms, 2);

  const missingAllow = H.runBin('leak-scan', ['scan', repo, '--allow', path.join(H.freshDir("ac23-does-not-exist-2"), "ac23-does-not-exist-2.txt")], { gnupgHome: gpg.gnupgHome });
  T.exit('AC-23: a --allow file that does not exist is a usage error, exit 2', missingAllow, 2);

  const unknownSub = H.runBin('leak-scan', ['frobnicate', repo], { gnupgHome: gpg.gnupgHome });
  T.exit('AC-23: an unknown subcommand is a usage error, exit 2', unknownSub, 2);
}

T.finish();
