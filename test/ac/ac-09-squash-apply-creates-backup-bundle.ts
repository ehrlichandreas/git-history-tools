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

H.requireBin('git-release-squash');

const gpg = H.setupGpg('ac09');
if (gpg) {
  const repo = H.initRepo('ac09', gpg);
  H.commit(repo, gpg, 'root', { 'a.txt': 'one\n' });
  H.tagSigned(repo, gpg, 'v1', 'release v1');

  const branch = H.branchName(repo, gpg);
  const headBefore = H.revParse(repo, gpg, 'HEAD');
  const v1Before = H.revParse(repo, gpg, 'v1');

  const map = path.join(H.freshDir("ac09-map"), "ac09-map.txt");
  const r = H.runBin('git-release-squash', ['apply', repo, '--map', map, '--apply'], { gnupgHome: gpg.gnupgHome });
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

/* Bug fix regression: lib/bundle.ts's createBackupBundle() used to compute
 * basename/dirname on the given <repo> argument as-is, not resolved to an
 * absolute path first. For a relative form like '.' (very normal once
 * already cd'd into the repo -- README.md's own examples do this),
 * path.dirname('.') is '.' itself, so the bundle landed INSIDE the repo's
 * own working tree instead of as a sibling next to it.
 *
 * A trailing slash or an embedded '..' do NOT reproduce this bug and are
 * deliberately not covered here: fixture repo paths (from H.initRepo) are
 * already absolute, and once a path is absolute, Node's own path.dirname/
 * path.basename already strip a trailing slash, and path.join's normalize
 * already cancels a redundant '..' segment -- the old, unfixed code
 * already produced the right sibling path for both. The bug is strictly
 * about a RELATIVE <repo> (no absolute root for dirname/basename to
 * recover), which '.' is the natural way to trigger. */
{
  const gpg = H.setupGpg('ac09-dot');
  if (gpg) {
    const repo = H.initRepo('ac09-dot', gpg);
    H.commit(repo, gpg, 'root', { 'a.txt': 'one\n' });

    const r = H.runBin('git-release-squash', ['tail', '.', '--apply'], { gnupgHome: gpg.gnupgHome, cwd: repo });
    T.exit('AC-09 (repo="."): tail --apply exit 0', r, 0);
    if (!r.missing) {
      const parent = path.dirname(repo);
      const base = path.basename(repo);
      const entries = fs.readdirSync(parent).filter(n => n.startsWith(base + '.backup-') && n.endsWith('.bundle'));
      T.check('AC-09 (repo="."): exactly one backup bundle lands next to the repo, not inside it',
        entries.length === 1, 'next to repo: ' + JSON.stringify(fs.readdirSync(parent)));
      const status = H.gitRaw(repo, gpg, ['status', '--porcelain']);
      T.eq('AC-09 (repo="."): working tree is clean afterward (no stray bundle inside it)', status.trim(), '');
    }
  }
}

T.finish();
