/* AC-10 -- § 1.2: the map file written by `apply --apply` has one
 * "<old-full-sha> <tag>" line per ORIGINAL commit, including every commit
 * folded into a tag, not just the tag commits themselves. */
import fs from 'node:fs';
import path from 'node:path';
import * as H from '../lib/harness.ts';
const T = H.T;

H.requireBin('git-release-squash');

const gpg = H.setupGpg('ac10');
if (gpg) {
  const repo = H.initRepo('ac10', gpg);
  const c1 = H.commit(repo, gpg, 'root', { 'a.txt': 'one\n' });
  const c2 = H.commit(repo, gpg, 'second', { 'a.txt': 'two\n' });
  const c3 = H.commit(repo, gpg, 'third (tagged)', { 'a.txt': 'three\n' });
  H.tagSigned(repo, gpg, 'v1', 'release v1');

  const map = path.join(H.freshDir("ac10-map"), "ac10-map.txt");
  try { fs.unlinkSync(map); } catch (e) {}
  const r = H.runBin('git-release-squash', ['apply', repo, '--map', map, '--apply'], { gnupgHome: gpg.gnupgHome });
  T.exit('AC-10 apply --apply: exit 0', r, 0);
  if (!r.missing) {
    T.check('AC-10: the map file was written', fs.existsSync(map), map);
    if (fs.existsSync(map)) {
      const lines = fs.readFileSync(map, 'utf8').split('\n').filter(Boolean);
      const byOld: Record<string, string> = {};
      for (const l of lines) {
        const m = /^([0-9a-f]{40}) (.+)$/.exec(l);
        T.check('AC-10: line "' + l + '" matches "<40-hex-sha> <tag>"', !!m, l);
        if (m) byOld[m[1]] = m[2];
      }
      T.eq('AC-10: exactly 3 map lines, one per original commit', lines.length, 3);
      T.eq('AC-10: root commit maps to v1', byOld[c1.sha!], 'v1');
      T.eq('AC-10: second (folded) commit maps to v1', byOld[c2.sha!], 'v1');
      T.eq('AC-10: third (the tag commit itself) maps to v1', byOld[c3.sha!], 'v1');
    }
  }
}

T.finish();
