/* AC-11 -- § 4.3: --dates=anon (the default) assigns commit i (1-BASED,
 * oldest first -- D1, commit bd16ac2) exactly 1970-01-(i+1) 12:00:00
 * +0000, author and committer alike; the root commit is i=1, so it lands
 * on 1970-01-02, not 1970-01-01. The tag's tagger date follows its own
 * commit's date. */
import path from 'node:path';
import * as H from '../lib/harness.ts';
const T = H.T;

H.requireBin('release-squash');

function identLine(repo: string, gpg: H.Gpg, rev: string, field: string): string | null {
  const raw = H.catFile(repo, gpg, rev, '-p');
  const m = new RegExp('^' + field + ' .* (\\d+ [+-]\\d{4})$', 'm').exec(raw);
  return m ? m[1] : null;
}
function unix1970(i: number): number { return Math.floor(Date.UTC(1970, 0, i + 1, 12, 0, 0) / 1000); }

const gpg = H.setupGpg('ac11');
if (gpg) {
  const repo = H.initRepo('ac11', gpg);
  H.commit(repo, gpg, 'root', { 'a.txt': 'one\n' }, { date: '2020-05-01T08:00:00 +0200' });
  H.tagSigned(repo, gpg, 'v1', 'release v1');
  H.commit(repo, gpg, 'second', { 'a.txt': 'two\n' }, { date: '2021-06-02T09:00:00 +0200' });
  H.tagSigned(repo, gpg, 'v2', 'release v2');

  const map = path.join(H.freshDir("ac11-map"), "ac11-map.txt");
  const r = H.runBin('release-squash', ['apply', repo, '--map', map, '--apply'], { gnupgHome: gpg.gnupgHome });
  T.exit('AC-11 apply --apply (default --dates=anon): exit 0', r, 0);
  if (!r.missing) {
    /* v1/v2 are annotated tags -- rev-parse'ing the bare name resolves to
     * the TAG object, not the commit it points at; '^{commit}' peels it so
     * the author/committer date checks below read the commit, not the
     * tag. The tagger-date checks further down deliberately stay on the
     * tag object itself. */
    const v1 = H.revParse(repo, gpg, 'v1^{commit}');
    const v2 = H.revParse(repo, gpg, 'v2^{commit}');
    T.eq('AC-11: commit 1 (v1, the root) author date is exactly 1970-01-02 12:00:00 +0000',
      identLine(repo, gpg, v1, 'author'), unix1970(1) + ' +0000');
    T.eq('AC-11: commit 1 (v1) committer date matches too', identLine(repo, gpg, v1, 'committer'), unix1970(1) + ' +0000');
    T.eq('AC-11: commit 2 (v2) author date is exactly 1970-01-03 12:00:00 +0000',
      identLine(repo, gpg, v2, 'author'), unix1970(2) + ' +0000');
    T.eq('AC-11: commit 2 (v2) committer date matches too', identLine(repo, gpg, v2, 'committer'), unix1970(2) + ' +0000');

    const tagRaw1 = H.catFile(repo, gpg, 'v1', '-p');
    const tagRaw2 = H.catFile(repo, gpg, 'v2', '-p');
    const tm1 = /^tagger .* (\d+ [+-]\d{4})$/m.exec(tagRaw1);
    const tm2 = /^tagger .* (\d+ [+-]\d{4})$/m.exec(tagRaw2);
    T.eq('AC-11: v1\'s tagger date equals its own (commit 1\'s) date', tm1 && tm1[1], unix1970(1) + ' +0000');
    T.eq('AC-11: v2\'s tagger date equals its own (commit 2\'s) date', tm2 && tm2[1], unix1970(2) + ' +0000');
  }
}

T.finish();
