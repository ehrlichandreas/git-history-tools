/* AC-08 -- § 1.2 / § 0: `apply` without --apply changes no ref and writes
 * no map file, even though --map was given; prints the dry-run line and
 * exits 0. */
import fs from 'node:fs';
import path from 'node:path';
import * as H from '../lib/harness.ts';
const T = H.T;

H.requireBin('release-squash');

const gpg = H.setupGpg('ac08');
if (gpg) {
  const repo = H.initRepo('ac08', gpg);
  H.commit(repo, gpg, 'root', { 'a.txt': 'one\n' });
  H.tagSigned(repo, gpg, 'v1', 'release v1');
  H.commit(repo, gpg, 'second', { 'a.txt': 'two\n' });
  H.tagSigned(repo, gpg, 'v2', 'release v2');

  const refsBefore = H.gitRaw(repo, gpg, ['show-ref']);
  const map = path.join(H.freshDir("ac08-map"), "ac08-map.txt");
  try { fs.unlinkSync(map); } catch (e) {}

  const r = H.runBin('release-squash', ['apply', repo, '--map', map], { gnupgHome: gpg.gnupgHome });
  T.exit('AC-08 apply (no --apply): exit 0', r, 0);
  if (!r.missing) {
    T.contains('AC-08: per-tag report lines present (same shape as plan)', r.stdout, 'plan: v1 folds');
    T.contains('AC-08: dry-run line present', r.stdout, 'release-squash: dry run, no ref changed (use --apply to write)');
    T.check('AC-08: the map file was NOT written despite --map being given', !fs.existsSync(map), map);
    const refsAfter = H.gitRaw(repo, gpg, ['show-ref']);
    T.eq('AC-08: every ref is byte-identical to before the dry run', refsAfter, refsBefore);
  }
}

T.finish();
