/* AC-20 -- § 2.1: a hit that exists ONLY in a commit's author identity
 * line (not in any blob or message text) is still found, path shown as
 * the literal "(identity)". */
import * as H from '../lib/harness.ts';
const T = H.T;

H.requireBin('leak-scan');

const gpg = H.setupGpg('ac20');
if (gpg) {
  const repo = H.initRepo('ac20', gpg);
  const git = H.gitIn(repo, gpg);
  git(['config', 'user.email', 'jdoe@internal.example']);
  const c1 = H.commit(repo, gpg, 'ordinary clean commit message', { 'a.txt': 'nothing sensitive\n' });

  const r = H.runBin('leak-scan', ['scan', repo], { gnupgHome: gpg.gnupgHome });
  T.exit('AC-20 scan: the author-identity-only leak is still found, exit 1', r, 1);
  if (!r.missing) {
    T.contains('AC-20: the email is reported', r.stdout, 'scan: email jdoe@internal.example');
    T.contains('AC-20: the path column is literally "(identity)"', r.stdout, ':(identity)');
  }
}

T.finish();
