'use strict';
/* AC-19 -- § 2.1: a hit that exists ONLY inside an annotated tag's own
 * message (no blob, no commit message) is still found, with path shown
 * as the literal "(tag-message)". */
const H = require('../lib/harness.js');
const T = H.T;

H.requireBin('ght-scan');

const gpg = H.setupGpg('ac19');
if (gpg) {
  const repo = H.initRepo('ac19', gpg);
  H.commit(repo, gpg, 'ordinary clean commit message', { 'a.txt': 'nothing sensitive\n' });
  H.tagSigned(repo, gpg, 'v1', 'release notes mention jdoe@internal.example by mistake');

  const r = H.runBin('ght-scan', ['scan', repo], { gnupgHome: gpg.gnupgHome });
  T.exit('AC-19 scan: the tag-message-only leak is still found, exit 1', r, 1);
  if (!r.missing) {
    T.contains('AC-19: hit reported with path "(tag-message)"',
      r.stdout, 'scan: email jdoe@internal.example (1) first at ');
    T.contains('AC-19: the path column is literally "(tag-message)"', r.stdout, ':(tag-message)');
  }
}

T.finish();
