/* AC-07 -- § 1.2: `apply` refuses when HEAD is not itself tagged (an
 * untagged tail exists -- that is what `tail` is for, not `apply`). */
import fs from 'node:fs';
import path from 'node:path';
import * as H from '../lib/harness.ts';
const T = H.T;

H.requireBin('git-release-squash');

const gpg = H.setupGpg('ac07');
if (gpg) {
  const repo = H.initRepo('ac07', gpg);
  H.commit(repo, gpg, 'root', { 'a.txt': 'one\n' });
  H.tagSigned(repo, gpg, 'v1', 'release v1');
  H.commit(repo, gpg, 'post v1, not tagged', { 'a.txt': 'two\n' });

  const map = path.join(H.freshDir("ac07-map"), "ac07-map.txt");
  const dry = H.runBin('git-release-squash', ['apply', repo, '--map', map], { gnupgHome: gpg.gnupgHome });
  T.exit('AC-07 apply (dry run) refuses an untagged HEAD too -- the refusal is about the repo shape, not writing', dry, 1);
  if (!dry.missing) T.contains('AC-07: names "HEAD is not tagged"', dry.stderr, 'HEAD is not tagged');

  const applied = H.runBin('git-release-squash', ['apply', repo, '--map', map, '--apply'], { gnupgHome: gpg.gnupgHome });
  T.exit('AC-07 apply --apply also refuses', applied, 1);
  if (!applied.missing) {
    T.contains('AC-07: same refusal with --apply', applied.stderr, 'HEAD is not tagged');
    T.check('AC-07: refers the reader to tail', applied.stderr.toLowerCase().includes('tail'), applied.stderr);
    T.check('AC-07: no map file written', !fs.existsSync(map), map);
  }
}

T.finish();
