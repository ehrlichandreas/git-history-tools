/* AC-28 -- § 3.1: `replace` also refuses when applying the rules would
 * change an annotated TAG's own message. */
import fs from 'node:fs';
import path from 'node:path';
import * as H from '../lib/harness.ts';
const T = H.T;

H.requireBin('git-history-rewrite');

const gpg = H.setupGpg('ac28');
if (gpg) {
  const repo = H.initRepo('ac28', gpg);
  H.commit(repo, gpg, 'clean commit message', { 'a.txt': 'clean content\n' });
  H.tagSigned(repo, gpg, 'v1', 'release notes mention jdoe@internal.example');

  const rulesFile = path.join(H.freshDir("ac28-rules"), "ac28-rules.txt");
  fs.writeFileSync(rulesFile, 'jdoe@internal.example\tREDACTED\n');

  const r = H.runBin('git-history-rewrite', ['replace', repo, '--rules', rulesFile], { gnupgHome: gpg.gnupgHome });
  T.exit('AC-28 replace refuses when a tag message would change', r, 1);
  if (!r.missing) T.contains('AC-28: refusal names the tag and the reason',
    r.stderr, 'tag v1 message would change -- replace only rewrites file contents');
}

T.finish();
