/* AC-95 -- § 0 / D21 (Scout N1): ght rewrites UTF-8 objects only. A tag
 * message with bytes like \351 \377 came out of `replace` as U+FFFD,
 * re-signed, exit 0; `resign-tags` moved the ref and only then said verify
 * FAILED; `replace` over an ISO-8859-1 commit lost the author's bytes and
 * the `encoding` header. Now any object a run would rewrite or re-sign
 * with bytes that are not UTF-8, or an `encoding` header other than
 * UTF-8, is a usage error before anything is written: exit 2, one stderr
 * line naming the object, nothing on stdout, no bundle, no ref moved, no
 * object written. A CRLF message is UTF-8 and still goes through. */
import fs from 'node:fs';
import path from 'node:path';
import * as H from '../lib/harness.ts';
const T = H.T;

const BINS = ['git-history-rewrite', 'git-sign', 'git-release-squash'];
for (const b of BINS) H.requireBin(b);

const outside = H.freshDir('ac95-files');
const rules = path.join(outside, 'rules.tsv');
fs.writeFileSync(rules, 'alpha\tomega\n');
const src = path.join(outside, 'NOTICE');
fs.writeFileSync(src, 'notice\n');

const LATIN1 = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x20, 0xff, 0xfe]); // "caf\351 \377\376"

function hashObject(repo: string, gpg: H.Gpg, type: string, body: Buffer): string {
  const r = H.gitIn(repo, gpg)(['hash-object', '-t', type, '-w', '--stdin'], { input: body });
  return String(r.stdout).trim();
}
/** A commit on top of HEAD, written byte for byte, and main moved to it. */
function rawCommit(repo: string, gpg: H.Gpg, author: Buffer, encoding: string | null, message: Buffer): string {
  const git = H.gitIn(repo, gpg);
  const tree = String(git(['rev-parse', 'HEAD^{tree}']).stdout).trim();
  const parent = String(git(['rev-parse', 'HEAD']).stdout).trim();
  const ident = Buffer.from(' <' + H.FIXTURE_EMAIL + '> 1000000000 +0000\n');
  const body = Buffer.concat([
    Buffer.from('tree ' + tree + '\nparent ' + parent + '\nauthor '), author, ident,
    Buffer.from('committer '), author, ident,
    Buffer.from(encoding ? 'encoding ' + encoding + '\n' : ''), Buffer.from('\n'), message, Buffer.from('\n'),
  ]);
  const sha = hashObject(repo, gpg, 'commit', body);
  git(['update-ref', 'refs/heads/main', sha]);
  return sha;
}
/** An annotated (unsigned) tag `name` on `target`, its message byte for byte. */
function rawTag(repo: string, gpg: H.Gpg, name: string, target: string, message: Buffer): void {
  const body = Buffer.concat([Buffer.from('object ' + target + '\ntype commit\ntag ' + name + '\ntagger GHT Test <' +
    H.FIXTURE_EMAIL + '> 1000000000 +0000\n\n'), message]);
  H.gitIn(repo, gpg)(['update-ref', 'refs/tags/' + name, hashObject(repo, gpg, 'tag', body)]);
}

type Setup = (repo: string, gpg: H.Gpg) => string; // returns the expected object label
const tagV1: Setup = (repo, gpg) => { rawTag(repo, gpg, 'v1', H.revParse(repo, gpg, 'HEAD~1'), Buffer.concat([LATIN1, Buffer.from('\n')])); return 'tag v1'; };
const commitLatin1: Setup = (repo, gpg) => 'commit ' + rawCommit(repo, gpg, Buffer.from('GHT Test'), 'ISO-8859-1', LATIN1).slice(0, 7);
const commitBadBytes: Setup = (repo, gpg) => 'commit ' + rawCommit(repo, gpg, Buffer.concat([Buffer.from('Jos'), Buffer.from([0xe9])]), null, Buffer.from('third')).slice(0, 7);
const headerOnly: Setup = (repo, gpg) => 'commit ' + rawCommit(repo, gpg, Buffer.from('GHT Test'), 'ISO-8859-1', Buffer.from('plain ascii')).slice(0, 7);
const tagV2Head: Setup = (repo, gpg) => { rawTag(repo, gpg, 'v2', H.revParse(repo, gpg, 'HEAD'), Buffer.concat([LATIN1, Buffer.from('\n')])); return 'tag v2'; };

const CASES: [string, string, Setup, (repo: string, policy: string) => string[]][] = [
  ['replace, a non-UTF-8 tag message', 'git-history-rewrite', tagV1, (r) => ['replace', r, '--rules', rules, '--apply']],
  ['replace dry run, a non-UTF-8 tag message', 'git-history-rewrite', tagV1, (r) => ['replace', r, '--rules', rules]],
  ['replace, an ISO-8859-1 commit', 'git-history-rewrite', commitLatin1, (r) => ['replace', r, '--rules', rules, '--apply']],
  ['replace, an ISO-8859-1 header on ASCII text', 'git-history-rewrite', headerOnly, (r) => ['replace', r, '--rules', rules, '--apply']],
  ['replace, a commit author with a stray byte', 'git-history-rewrite', commitBadBytes, (r) => ['replace', r, '--rules', rules, '--apply']],
  ['add-file, an ISO-8859-1 commit', 'git-history-rewrite', commitLatin1, (r) => ['add-file', r, src, '--apply']],
  ['resign-tags, a non-UTF-8 tag message', 'git-sign', tagV1, (r, p) => ['resign-tags', r, '--policy=' + p, '--apply']],
  ['resign-commits, an ISO-8859-1 commit', 'git-sign', commitLatin1, (r, p) => ['resign-commits', r, 'HEAD~1..HEAD', '--policy=' + p, '--apply']],
  ['apply, a non-UTF-8 tag message', 'git-release-squash', tagV2Head, (r) => ['apply', r, '--map', path.join(outside, 'map-' + path.basename(r)), '--apply']],
  ['tail, an ISO-8859-1 HEAD subject', 'git-release-squash', commitLatin1, (r) => ['tail', r, '--apply']],
];

for (const [label, bin, setup, args] of CASES) {
  const gpg = H.setupGpg('ac95');
  if (!gpg) continue;
  const policy = H.writePolicy('ac95', { signingKey: gpg.fingerprint, timezone: 'UTC' });
  const repo = H.initRepo('ac95', gpg);
  H.commit(repo, gpg, 'first', { 'a.txt': 'alpha\n' }, { date: '2001-09-09T01:46:40 +0000' });
  H.commit(repo, gpg, 'second', { 'a.txt': 'alpha beta\n' }, { date: '2001-09-09T01:46:40 +0000' });
  const what = setup(repo, gpg);
  const refs = () => H.gitRaw(repo, gpg, ['for-each-ref', '--format=%(refname) %(objectname)']);
  const before = refs();
  const objects = H.objectStoreSnapshot(repo, gpg);
  const l = 'AC-95 [' + label + ']';

  const r = H.runBin(bin, args(repo, policy), { gnupgHome: gpg.gnupgHome });
  T.exit(l + ': a usage error, exit 2', r, 2);
  T.check(l + ': one stderr line naming ' + what, r.stderr.startsWith(bin + ': ' + what + ' is not UTF-8 (') && r.stderr.split('\n').length === 2, r.stderr);
  T.eq(l + ': nothing on stdout', r.stdout, '');
  T.eq(l + ': no ref moved', refs(), before);
  T.eq(l + ': no backup bundle', H.findBackupBundle(repo), null);
  T.eq(l + ': no object written', H.objectStoreDiff(objects, H.objectStoreSnapshot(repo, gpg)).added.length, 0);
}

/* A CRLF tag message is UTF-8: not refused. */
{
  const gpg = H.setupGpg('ac95');
  if (gpg) {
    const repo = H.initRepo('ac95', gpg);
    H.commit(repo, gpg, 'first', { 'a.txt': 'alpha\n' });
    rawTag(repo, gpg, 'v1', H.revParse(repo, gpg, 'HEAD'), Buffer.from('title\r\n\r\nbody\r\n'));
    H.commit(repo, gpg, 'second', { 'a.txt': 'alpha beta\n' });
    const r = H.runBin('git-history-rewrite', ['replace', repo, '--rules', rules], { gnupgHome: gpg.gnupgHome });
    T.exit('AC-95 [replace dry run, a CRLF tag message]: exit 0', r, 0);
  }
}

T.finish();
