/* AC-79 -- § 3.1 / D20 (Reviewer R2): a tag message without a trailing
 * newline. `git tag -a --cleanup=verbatim -m x` stores the message with no
 * newline at the end. `buildSignedTagObject` signed text + message
 * verbatim, so the signature was glued to the message's last line
 * ("x-----BEGIN PGP SIGNATURE-----"): `git verify-tag` failed, and every
 * ref had already moved. A non-empty message without a trailing newline
 * now gets one before it is signed -- the one exception to "byte for
 * byte" -- in git-history-rewrite and in git-sign's resign-tags and
 * resign-commits, which build their tags with the same function. A
 * message that ends in a newline, `#` lines and trailing spaces included,
 * is unchanged. */
import fs from 'node:fs';
import path from 'node:path';
import * as H from '../lib/harness.ts';
const T = H.T;

H.requireBin('git-history-rewrite');
H.requireBin('git-sign');

const outside = H.freshDir('ac79-files');
const extra = path.join(outside, 'extra.txt');
fs.writeFileSync(extra, 'extra\n');
const msgFile = path.join(outside, 'msg');
fs.writeFileSync(msgFile, 'subject\n\n# a hash line\ntrailing  \n');

/* [tag, how it is made, its message before, its message after] */
const TAGS: [string, string[], string, string][] = [
  ['t-plain', ['-c', 'tag.gpgsign=false', 'tag', '-a', '--cleanup=verbatim', '-m', 'no newline unsigned', 't-plain'], 'no newline unsigned', 'no newline unsigned\n'],
  ['t-signed', ['tag', '-s', '--cleanup=verbatim', '-m', 'no newline signed', 't-signed'], '', ''],
  ['t-hash', ['-c', 'tag.gpgsign=false', 'tag', '-a', '--cleanup=verbatim', '-F', msgFile, 't-hash'], 'subject\n\n# a hash line\ntrailing  \n', 'subject\n\n# a hash line\ntrailing  \n'],
];

function messageOf(repo: string, gpg: H.Gpg, tag: string): string {
  const raw = H.gitIn(repo, gpg)(['cat-file', 'tag', 'refs/tags/' + tag]).stdout as string;
  const body = raw.slice(raw.indexOf('\n\n') + 2);
  const sig = body.indexOf('-----BEGIN PGP SIGNATURE-----');
  return sig === -1 ? body : body.slice(0, sig);
}

for (const [label, bin, args] of [
  ['add-file --apply', 'git-history-rewrite', (r: string, _p: string) => ['add-file', r, extra, '--as=extra.txt', '--apply']],
  ['resign-tags --apply', 'git-sign', (r: string, p: string) => ['resign-tags', r, 't-plain', 't-signed', 't-hash', '--policy=' + p, '--apply']],
  ['resign-commits --apply', 'git-sign', (r: string, p: string) => ['resign-commits', r, 'main', '--from-root', '--policy=' + p, '--apply']],
] as [string, string, (r: string, p: string) => string[]][]) {
  const gpg = H.setupGpg('ac79');
  if (!gpg) continue;
  const repo = H.initRepo('ac79', gpg);
  H.commit(repo, gpg, 'one', { 'a.txt': 'a\n' });
  const git = H.gitIn(repo, gpg);
  for (const [, make] of TAGS) {
    const r = git(make);
    T.check('AC-79 fixture: ' + make.join(' '), r.status === 0, r.stderr as string);
  }
  /* The signed one: git itself puts a newline before its signature. */
  TAGS[1][2] = TAGS[1][3] = messageOf(repo, gpg, 't-signed');
  T.eq('AC-79 fixture: t-plain is stored with no trailing newline', messageOf(repo, gpg, 't-plain'), 'no newline unsigned');
  const policy = H.writePolicy('ac79', { signingKey: gpg.fingerprint });
  const l = 'AC-79 [' + label + ']';

  const r = H.runBin(bin, args(repo, policy), { gnupgHome: gpg.gnupgHome });
  T.exit(l + ': exit 0', r, 0);
  T.check(l + ': no verify line FAILED', !/FAILED/.test(r.stdout), r.stdout + r.stderr);
  for (const [tag, , , after] of TAGS) {
    const v = git(['verify-tag', 'refs/tags/' + tag]);
    T.check(l + ': ' + tag + ' passes git verify-tag', v.status === 0, v.stderr as string);
    T.eq(l + ': ' + tag + ' message', messageOf(repo, gpg, tag), after);
  }
}

T.finish();
