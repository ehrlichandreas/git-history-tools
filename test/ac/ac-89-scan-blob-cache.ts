/* AC-89 -- § 2.1 / D22: `scan` reads and scans each distinct blob once.
 * Every commit's whole tree used to be read blob by blob, so a file left
 * unchanged across N commits was read and scanned N times. The hits are
 * now cached by blob sha. The report itself is unchanged: `<count>` still
 * counts every (commit, path) pair, an unchanged file included, and the
 * same blob under two paths is two pairs. git's own GIT_TRACE shows
 * which `cat-file` reads the tool made. */
import fs from 'node:fs';
import path from 'node:path';
import * as H from '../lib/harness.ts';
const T = H.T;

H.requireBin('git-leak-scan');

const gpg = H.setupGpg('ac89');
if (gpg) {
  const repo = H.initRepo('ac89', gpg);
  const SECRET = 'token=abcdefghijklmnopqrstuvwx';
  let first = '';
  for (let i = 1; i <= 6; i++) {
    const files: Record<string, string> = { 'changing.txt': 'version ' + i + '\n' };
    if (i === 1) files['same.txt'] = SECRET + '\n';
    if (i === 4) files['copy.txt'] = SECRET + '\n';
    const c = H.commit(repo, gpg, 'commit ' + i, files);
    if (i === 1) first = H.shortSha(repo, gpg, c.sha!);
  }
  const blobs = new Set(H.gitRaw(repo, gpg, ['rev-list', '--all', '--objects']).split('\n')
    .map((l) => l.split(' ')[0]).filter((sha) => sha && H.gitRaw(repo, gpg, ['cat-file', '-t', sha]).trim() === 'blob'));

  const out = H.freshDir('ac89-trace');
  const trace = path.join(out, 'trace.txt');
  const allow = path.join(out, 'allow.txt');
  fs.writeFileSync(allow, H.FIXTURE_EMAIL + '\n');
  const r = H.runBin('git-leak-scan', ['scan', repo, '--allow', allow], { gnupgHome: gpg.gnupgHome, env: { GIT_TRACE: trace } });
  T.exit('AC-89: the secret is found, exit 1', r, 1);
  T.eq('AC-89: the count is every (commit, path) pair: same.txt in 6 commits, copy.txt in 3', r.stdout,
    'scan: secret ' + SECRET + ' (9) first at ' + first + ':same.txt\n');

  const reads = fs.readFileSync(trace, 'utf8').split('\n').filter((l) => / cat-file /.test(l))
    .map((l) => l.trim().split(/\s+/).pop()!);
  const perBlob = new Map<string, number>();
  for (const sha of reads) perBlob.set(sha, (perBlob.get(sha) || 0) + 1);
  const twice = [...perBlob].filter(([, n]) => n > 1);
  T.eq('AC-89: no blob is read twice', twice.map(([sha, n]) => sha.slice(0, 7) + ' x' + n).join(', '), '');
  T.eq('AC-89: every distinct blob is read once (' + blobs.size + ')', [...blobs].filter((b) => perBlob.get(b) !== 1).length, 0);
}

T.finish();
