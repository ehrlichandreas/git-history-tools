'use strict';
/* AC-06 -- § 1.2: `apply --apply` refuses a dirty working tree; a dry run
 * (no --apply) tolerates one, same as `plan`. */
const fs = require('fs');
const path = require('path');
const H = require('../lib/harness.js');
const T = H.T;

H.requireBin('ght-squash');

const gpg = H.setupGpg('ac06');
if (gpg) {
  const repo = H.initRepo('ac06', gpg);
  H.commit(repo, gpg, 'root', { 'a.txt': 'one\n' });
  H.tagSigned(repo, gpg, 'v1', 'release v1');
  /* HEAD stays exactly on v1 -- a dirty-tree refusal must be reachable
   * without ALSO tripping the "HEAD is not tagged" refusal (AC-07 covers
   * that one on its own). */

  fs.writeFileSync(path.join(repo, 'a.txt'), 'dirty uncommitted change\n');
  const map = path.join(H.freshDir("ac06-map"), "ac06-map.txt");

  const dry = H.runBin('ght-squash', ['apply', repo, '--map', map], { gnupgHome: gpg.gnupgHome });
  T.exit('AC-06 apply dry run (no --apply): tolerates a dirty tree, exit 0', dry, 0);

  const applied = H.runBin('ght-squash', ['apply', repo, '--map', map, '--apply'], { gnupgHome: gpg.gnupgHome });
  T.exit('AC-06 apply --apply: refuses the dirty tree', applied, 1);
  if (!applied.missing) {
    T.contains('AC-06: refusal names "working tree is dirty"', applied.stderr, 'working tree is dirty');
    T.check('AC-06: the map file was NOT written by the refused --apply', !fs.existsSync(map), map);
  }
}

T.finish();
