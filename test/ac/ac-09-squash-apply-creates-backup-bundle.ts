/* AC-09 -- § 4.1: `--apply` creates the backup bundle before touching any
 * ref: <parent-of-repo>/<repo-basename>.backup-<UTC>.bundle, a `git bundle
 * create --all` snapshot of every ref as it stood before the rewrite.
 * Order matters here, not just presence: a bundle taken AFTER the rewrite
 * would still carry refs named refs/heads/<branch> and refs/tags/v1, but
 * pointing at the NEW (post-rewrite) shas -- so the check below compares
 * the bundle's own shas against the PRE-run ones, not merely checking the
 * ref names appear. */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as H from '../lib/harness.ts';
const T = H.T;

H.requireBin('release-squash');

const gpg = H.setupGpg('ac09');
if (gpg) {
  const repo = H.initRepo('ac09', gpg);
  H.commit(repo, gpg, 'root', { 'a.txt': 'one\n' });
  H.tagSigned(repo, gpg, 'v1', 'release v1');

  const branch = H.branchName(repo, gpg);
  const headBefore = H.revParse(repo, gpg, 'HEAD');
  const v1Before = H.revParse(repo, gpg, 'v1');

  const map = path.join(H.freshDir("ac09-map"), "ac09-map.txt");
  const r = H.runBin('release-squash', ['apply', repo, '--map', map, '--apply'], { gnupgHome: gpg.gnupgHome });
  T.exit('AC-09 apply --apply: exit 0 on a clean single-tag repo', r, 0);
  if (!r.missing) {
    const base = path.basename(repo);
    const dir = path.dirname(repo);
    const entries = fs.readdirSync(dir).filter(n => n.startsWith(base + '.backup-') && n.endsWith('.bundle'));
    T.check('AC-09: exactly one backup bundle named <repo-basename>.backup-<UTC>.bundle appears next to the repo',
      entries.length === 1, 'dir listing: ' + JSON.stringify(fs.readdirSync(dir)));
    if (entries.length === 1) {
      const m = /^.+\.backup-(\d{8}T\d{6}Z)\.bundle$/.exec(entries[0]);
      T.check('AC-09: the UTC stamp matches YYYYMMDDTHHMMSSZ', !!m, entries[0]);
      const bundlePath = path.join(dir, entries[0]);
      const verify = spawnSync('git', ['bundle', 'verify', bundlePath], { encoding: 'utf8' });
      T.check('AC-09: git bundle verify accepts the bundle', verify.status === 0, verify.stderr);

      const heads = H.bundleListHeads(bundlePath);
      T.eq('AC-09: the bundle\'s branch head is the PRE-apply commit (bundled before the rewrite, not after)',
        heads['refs/heads/' + branch], headBefore);
      T.eq('AC-09: the bundle\'s v1 is the PRE-apply tag object (not the one apply re-points v1 to)',
        heads['refs/tags/v1'], v1Before);

      const headAfter = H.revParse(repo, gpg, 'HEAD');
      T.check('AC-09 sanity: apply actually rewrote HEAD (otherwise the above could pass by coincidence)',
        headAfter !== headBefore, headAfter);
    }
  }
}

T.finish();
