/* AC-84 -- § 4.1 / D21 (Scout N5): the backup bundle goes next to the
 * real top level. `<repo>` may reach the top level through a symlink
 * (AC-70 accepts it), but the bundle was placed next to the path as
 * given: `r/self -> .`, committed inside the work tree, put
 * `self.backup-<UTC>.bundle` INSIDE r as an untracked file, and a symlink
 * elsewhere put the bundle next to the link, away from the repository.
 * The bundle is now `<realpath of the top level>.backup-<UTC>.bundle`,
 * and the `backup: <path>` line (D23) names that real path. */
import fs from 'node:fs';
import path from 'node:path';
import * as H from '../lib/harness.ts';
const T = H.T;

H.requireBin('git-history-rewrite');

const outside = H.freshDir('ac84-files');
const rules = path.join(outside, 'rules.tsv');
fs.writeFileSync(rules, 'alpha\tomega\n');

const bundlesIn = (dir: string) => fs.readdirSync(dir).filter((n) => /\.backup-\d{8}T\d{6}Z\.bundle$/.test(n));

for (const label of ['r/self -> . inside the work tree', 'a symlink elsewhere -> r']) {
  const gpg = H.setupGpg('ac84');
  if (!gpg) continue;
  const repo = fs.realpathSync(H.initRepo('ac84', gpg));
  H.commit(repo, gpg, 'first', { 'a.txt': 'alpha\n' });
  let given: string;
  if (label.startsWith('r/self')) {
    given = path.join(repo, 'self');
    fs.symlinkSync('.', given);
    H.gitIn(repo, gpg)(['add', 'self']);
    H.commit(repo, gpg, 'self link', {});
  } else {
    given = path.join(H.freshDir('ac84-link'), 'link');
    fs.symlinkSync(repo, given);
  }
  const l = 'AC-84 [' + label + ']';
  const r = H.runBin('git-history-rewrite', ['replace', given, '--rules', rules, '--apply'], { gnupgHome: gpg.gnupgHome });
  T.exit(l + ': exit 0', r, 0);
  const mine = bundlesIn(path.dirname(repo)).filter((n) => n.startsWith(path.basename(repo) + '.backup-'));
  T.eq(l + ': one bundle next to the real top level, named after it', mine.length, 1);
  T.eq(l + ': the first stdout line names that bundle by its real path (D23)',
    r.stdout.split('\n')[0], 'backup: ' + path.join(path.dirname(repo), mine[0] || '<none>'));
  T.eq(l + ': no bundle inside the work tree', bundlesIn(repo).join(' '), '');
  T.eq(l + ': no bundle next to the path as given', bundlesIn(path.dirname(given)).filter((n) => n.startsWith('link.') || n.startsWith('self.')).join(' '), '');
  T.eq(l + ': nothing untracked in the work tree', H.gitRaw(repo, gpg, ['status', '--porcelain']).split('\n').filter((x) => x.startsWith('??')).join(' '), '');
}

T.finish();
