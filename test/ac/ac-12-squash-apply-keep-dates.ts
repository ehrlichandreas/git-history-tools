/* AC-12 -- § 4.3: --dates=keep preserves the original commit's author and
 * committer dates byte-for-byte instead of anonymising them. */
import path from 'node:path';
import * as H from '../lib/harness.ts';
const T = H.T;

H.requireBin('git-release-squash');

function identLine(repo: string, gpg: H.Gpg, rev: string, field: string): string | null {
  const raw = H.catFile(repo, gpg, rev, '-p');
  const m = new RegExp('^' + field + ' .* (\\d+ [+-]\\d{4})$', 'm').exec(raw);
  return m ? m[1] : null;
}

const gpg = H.setupGpg('ac12');
if (gpg) {
  const repo = H.initRepo('ac12', gpg);
  const c1 = H.commit(repo, gpg, 'root', { 'a.txt': 'one\n' }, { date: '2020-05-01T08:00:00 +0200' });
  H.tagSigned(repo, gpg, 'v1', 'release v1');
  const beforeAuthor = identLine(repo, gpg, c1.sha!, 'author');
  const beforeCommitter = identLine(repo, gpg, c1.sha!, 'committer');

  const map = path.join(H.freshDir("ac12-map"), "ac12-map.txt");
  const r = H.runBin('git-release-squash', ['apply', repo, '--map', map, '--dates=keep', '--apply'], { gnupgHome: gpg.gnupgHome });
  T.exit('AC-12 apply --apply --dates=keep: exit 0', r, 0);
  if (!r.missing) {
    const v1 = H.revParse(repo, gpg, 'v1^{commit}'); /* v1 is an annotated tag -- peel to the commit */
    T.eq('AC-12: author date is preserved byte-for-byte', identLine(repo, gpg, v1, 'author'), beforeAuthor);
    T.eq('AC-12: committer date is preserved byte-for-byte', identLine(repo, gpg, v1, 'committer'), beforeCommitter);
  }

  const bad = H.runBin('git-release-squash', ['apply', repo, '--map', map, '--dates=whatever'], { gnupgHome: gpg.gnupgHome });
  T.exit('AC-12: an unrecognised --dates value is a usage error, exit 2', bad, 2);
}

T.finish();
