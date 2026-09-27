/* AC-03 -- § 1.1: lightweight and annotated tags are both walked and
 * reported in the same line shape; a lightweight tag's `<title>` falls
 * back to the pointed-to commit's own subject (§ 0). Also § 1.2: after
 * `apply --apply` re-points every tag at its new squash commit, each tag
 * KEEPS ITS OWN TYPE -- a lightweight tag must not come back as an
 * annotated/signed one just because the repo's own tag.gpgsign=true
 * fixture config would otherwise force that on a plain `git tag`
 * (test/lib/harness.ts's tagLightweight() already works around that for
 * the fixture's own setup step; this checks the tool's rewrite does too). */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import * as H from '../lib/harness.ts';
const T = H.T;

H.requireBin('git-release-squash');

function objType(repo: string, gpg: H.Gpg, rev: string): string {
  const r = spawnSync('git', ['cat-file', '-t', rev], { cwd: repo, env: gpg.env, encoding: 'utf8' });
  return (r.stdout || '').trim();
}

const gpg = H.setupGpg('ac03');
if (gpg) {
  const repo = H.initRepo('ac03', gpg);
  H.commit(repo, gpg, 'root', { 'a.txt': 'one\n' });
  H.tagLightweight(repo, gpg, 'v1'); /* lightweight -- no tag object, no message */

  H.commit(repo, gpg, 'second subject line', { 'a.txt': 'two\n' });
  H.tagSigned(repo, gpg, 'v2', 'annotated release title');

  T.eq('AC-03 fixture: v1 really is lightweight (points straight at a commit) despite tag.gpgsign=true',
    objType(repo, gpg, 'v1'), 'commit');
  T.eq('AC-03 fixture: v2 really is an annotated tag object', objType(repo, gpg, 'v2'), 'tag');

  const r = H.runBin('git-release-squash', ['plan', repo], { gnupgHome: gpg.gnupgHome });
  T.exit('AC-03 plan: exit 0 across a lightweight and an annotated tag', r, 0);
  if (!r.missing) {
    T.contains('AC-03: lightweight tag v1 is reported like any other tag',
      r.stdout, 'plan: v1 folds 1 commit(s)');
    T.contains('AC-03: lightweight v1\'s subject falls back to its commit\'s own subject',
      r.stdout, '"root"');
    T.contains('AC-03: annotated tag v2 is reported', r.stdout, 'plan: v2 folds 1 commit(s)');
    T.contains('AC-03: annotated v2\'s subject is its own tag message, not the commit subject',
      r.stdout, '"annotated release title"');
    T.check('AC-03: v2\'s line does not instead show the commit subject "second subject line"',
      !r.stdout.includes('"second subject line"'), r.stdout);
    T.contains('AC-03: both tags get a tree-equality OK line', r.stdout, 'plan: v1 tree equals');
    T.contains('AC-03: v2 tree-equality OK', r.stdout, 'plan: v2 tree equals');
  }

  const map = path.join(H.freshDir("ac03-map"), "ac03-map.txt");
  const applied = H.runBin('git-release-squash', ['apply', repo, '--map', map, '--apply'], { gnupgHome: gpg.gnupgHome });
  T.exit('AC-03 apply --apply: exit 0', applied, 0);
  if (!applied.missing) {
    T.eq('AC-03 apply: v1 is STILL lightweight after the rewrite, not upgraded to an annotated/signed tag',
      objType(repo, gpg, 'v1'), 'commit');
    T.eq('AC-03 apply: v2 is still an annotated tag object', objType(repo, gpg, 'v2'), 'tag');
  }
}

T.finish();
