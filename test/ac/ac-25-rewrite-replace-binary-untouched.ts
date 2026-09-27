/* AC-25 -- § 3.1: a binary blob (contains a NUL within the first 8000
 * bytes) is copied byte-for-byte into the new tree, untouched, even when
 * its bytes happen to contain a rule's "from" text. */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as H from '../lib/harness.ts';
const T = H.T;

H.requireBin('git-history-rewrite');

const gpg = H.setupGpg('ac25');
if (gpg) {
  const repo = H.initRepo('ac25', gpg);
  const binary = Buffer.concat([Buffer.from('jdoe@internal.example'), Buffer.from([0, 1, 2, 3, 0, 255, 254])]);
  H.commit(repo, gpg, 'add binary blob containing the leak text', { 'blob.bin': binary });

  const rulesFile = path.join(H.freshDir("ac25-rules"), "ac25-rules.txt");
  fs.writeFileSync(rulesFile, 'jdoe@internal.example\tREDACTED\n');

  const r = H.runBin('git-history-rewrite', ['replace', repo, '--rules', rulesFile, '--apply'], { gnupgHome: gpg.gnupgHome });
  T.exit('AC-25 replace --apply: exit 0', r, 0);
  if (!r.missing) {
    const headSha = H.revParse(repo, gpg, 'HEAD');
    const raw = spawnSync('git', ['cat-file', '-p', headSha + ':blob.bin'],
      { cwd: repo, env: gpg.env, encoding: 'buffer' });
    T.check('AC-25: the binary blob is byte-identical to the original -- the rule did not touch it',
      Buffer.isBuffer(raw.stdout) && raw.stdout.equals(binary),
      'got ' + (raw.stdout ? raw.stdout.length : 'null') + ' bytes, want ' + binary.length);
  }
}

T.finish();
