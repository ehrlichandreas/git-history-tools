/* AC-85 -- § 1 / D21 (Scout N6): `apply --map` is written only once
 * every ref has moved. The map was written before the ref transaction,
 * so a failed transaction (here a pre-existing `refs/tags/v2.lock`) left
 * a map of commits that no ref points at. Now a failed transaction
 * leaves no map file, and the same run without the lock writes it. */
import fs from 'node:fs';
import path from 'node:path';
import * as H from '../lib/harness.ts';
const T = H.T;

H.requireBin('git-release-squash');

const gpg = H.setupGpg('ac85');
if (gpg) {
  const repo = H.initRepo('ac85', gpg);
  H.commit(repo, gpg, 'first', { 'a.txt': 'a\n' });
  H.tagSigned(repo, gpg, 'v1', 'release one');
  H.commit(repo, gpg, 'second', { 'a.txt': 'a b\n' });
  H.tagSigned(repo, gpg, 'v2', 'release two');
  const map = path.join(H.freshDir('ac85-out'), 'map.txt');
  const lock = path.join(repo, '.git', 'refs', 'tags', 'v2.lock');
  fs.writeFileSync(lock, '');
  const refs = () => H.gitRaw(repo, gpg, ['for-each-ref', '--format=%(refname) %(objectname)']);
  const before = refs();

  const r = H.runBin('git-release-squash', ['apply', repo, '--map', map, '--apply'], { gnupgHome: gpg.gnupgHome });
  T.exit('AC-85 [locked v2]: a refusal, exit 1', r, 1);
  T.contains('AC-85 [locked v2]: the transaction refusal', r.stderr, 'git-release-squash: ref update transaction failed: ');
  T.eq('AC-85 [locked v2]: no ref moved', refs(), before);
  T.eq('AC-85 [locked v2]: no map file', fs.existsSync(map), false);

  fs.rmSync(lock);
  fs.rmSync(H.findBackupBundle(repo)!);
  const ok = H.runBin('git-release-squash', ['apply', repo, '--map', map, '--apply'], { gnupgHome: gpg.gnupgHome });
  T.exit('AC-85 [no lock]: exit 0', ok, 0);
  T.check('AC-85 [no lock]: the map is written, one line per old commit', fs.existsSync(map) &&
    fs.readFileSync(map, 'utf8').split('\n').filter(Boolean).length === 2, fs.existsSync(map) ? fs.readFileSync(map, 'utf8') : 'none');
}

T.finish();
