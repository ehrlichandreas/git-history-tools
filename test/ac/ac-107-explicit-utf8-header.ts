/* AC-107 -- § 0 (D21, D23): a source commit with an explicit UTF-8
 * `encoding` header, which D21 lets through and git itself never writes.
 * resign-commits wrote the re-signed commit without it (D23's pin), moved
 * the ref and only then said "headers preserved: FAILED", exit 1. Now any
 * `encoding` header on a commit it would re-sign is a refusal before
 * anything is written, D20 style: exit 1, one stderr line naming the
 * commit, nothing on stdout, no bundle, no ref moved, no object written --
 * dry run included. A commit without the header whose message has the
 * line `encoding UTF-8` is not refused. `replace --apply` and `add-file
 * --apply` drop the header (it says what no header says): exit 0, no
 * header, the message bytes as they were. */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as H from '../lib/harness.ts';
const T = H.T;

H.requireBin('git-sign');
H.requireBin('git-history-rewrite');

const outside = H.freshDir('ac107-files');
const rules = path.join(outside, 'rules.tsv');
fs.writeFileSync(rules, 'alpha\tomega\n');
const addSrc = path.join(outside, 'NOTICE');
fs.writeFileSync(addSrc, 'notice\n');
const MESSAGE = Buffer.from('café explicit\n\nbody\n');

/** A repo of two commits and, on top, a commit written byte for byte with
 * `encoding <enc>` (none when null) and `message`; main points at it. */
function fixture(label: string, enc: string | null, message = MESSAGE) {
  const gpg = H.setupGpg('ac107-' + label);
  if (!gpg) return null;
  const repo = H.initRepo('ac107-' + label, gpg);
  H.commit(repo, gpg, 'first', { 'a.txt': 'alpha\n' }, { date: '@1000000000 +0000' });
  H.commit(repo, gpg, 'second', { 'a.txt': 'alpha beta\n' }, { date: '@1000000100 +0000' });
  const git = H.gitIn(repo, gpg);
  const tree = String(git(['rev-parse', 'HEAD^{tree}']).stdout).trim();
  const parent = String(git(['rev-parse', 'HEAD']).stdout).trim();
  const ident = 'GHT Test <' + H.FIXTURE_EMAIL + '> 1000000200 +0000\n';
  const body = Buffer.concat([Buffer.from('tree ' + tree + '\nparent ' + parent + '\nauthor ' + ident +
    'committer ' + ident + (enc === null ? '' : 'encoding ' + enc + '\n') + '\n'), message]);
  const sha = String(git(['hash-object', '-t', 'commit', '-w', '--stdin'], { input: body }).stdout).trim();
  git(['update-ref', 'refs/heads/main', sha]);
  return { gpg, repo, sha };
}
const rawOf = (repo: string, gpg: H.Gpg, rev: string): Buffer =>
  spawnSync('git', ['cat-file', 'commit', rev], { cwd: repo, env: gpg.env }).stdout as Buffer;

/* 1. resign-commits refuses before the bundle, --apply and dry run. */
for (const [label, enc, apply] of [
  ['apply', 'UTF-8', true], ['dry run', 'UTF-8', false], ['apply, utf8', 'utf8', true],
] as [string, string, boolean][]) {
  const f = fixture('resign-' + label.replace(/\W+/g, '-'), enc);
  if (!f) continue;
  const { gpg, repo, sha } = f;
  const policy = H.writePolicy('ac107', { signingKey: gpg.fingerprint, timezone: 'UTC' });
  const refs = H.gitRaw(repo, gpg, ['for-each-ref']);
  const objects = H.objectStoreSnapshot(repo, gpg);
  const l = 'AC-107 [resign-commits ' + label + ', encoding ' + enc + ']';
  const r = H.runBin('git-sign', ['resign-commits', repo, 'HEAD~2..HEAD', '--policy=' + policy, ...(apply ? ['--apply'] : [])],
    { gnupgHome: gpg.gnupgHome });
  T.exit(l + ': a refusal, exit 1', r, 1);
  T.check(l + ': one stderr line naming the commit and its header',
    r.stderr.split('\n').length === 2 && r.stderr.includes('commit ' + sha.slice(0, 7) + ' has an encoding header (' + enc + ')'), r.stderr);
  T.eq(l + ': nothing on stdout', r.stdout, '');
  T.eq(l + ': no backup bundle', H.findBackupBundle(repo), null);
  T.eq(l + ': no ref moved', H.gitRaw(repo, gpg, ['for-each-ref']), refs);
  T.eq(l + ': no object written', JSON.stringify(H.objectStoreDiff(objects, H.objectStoreSnapshot(repo, gpg))),
    JSON.stringify({ added: [], removed: [], countChanged: false }));
}

/* 2. The header is read from the header lines only: a message line
 * `encoding UTF-8` on a commit without one is not refused. */
{
  const body = Buffer.from('subject\n\nencoding UTF-8\n');
  const f = fixture('resign-body', null, body);
  if (f) {
    const { gpg, repo } = f;
    const policy = H.writePolicy('ac107', { signingKey: gpg.fingerprint, timezone: 'UTC' });
    const l = 'AC-107 [resign-commits --apply, `encoding UTF-8` in the message only]';
    const r = H.runBin('git-sign', ['resign-commits', repo, 'HEAD~2..HEAD', '--policy=' + policy, '--apply'], { gnupgHome: gpg.gnupgHome });
    T.exit(l + ': exit 0', r, 0);
    const raw = rawOf(repo, gpg, 'HEAD');
    T.eq(l + ': the message bytes as they were', raw.subarray(raw.indexOf('\n\n') + 2).toString('hex'), body.toString('hex'));
  }
}

/* 3. replace and add-file --apply drop the header and keep the message bytes. */
for (const [label, bin, args] of [
  ['replace', 'git-history-rewrite', (r: string) => ['replace', r, '--rules', rules, '--apply']],
  ['add-file', 'git-history-rewrite', (r: string) => ['add-file', r, addSrc, '--apply']],
] as [string, string, (r: string) => string[]][]) {
  const f = fixture(label, 'UTF-8');
  if (f) {
    const { gpg, repo, sha } = f;
    const l = 'AC-107 [' + label + ' --apply, encoding UTF-8]';
    const r = H.runBin(bin, args(repo), { gnupgHome: gpg.gnupgHome });
    T.exit(l + ': exit 0', r, 0);
    const raw = rawOf(repo, gpg, 'HEAD');
    const end = raw.indexOf('\n\n');
    T.check(l + ': HEAD was rewritten', H.revParse(repo, gpg, 'HEAD') !== sha, '');
    T.eq(l + ': no encoding header', raw.subarray(0, end).toString('latin1').split('\n').filter((h) => h.startsWith('encoding ')), []);
    T.eq(l + ': the message bytes as they were', raw.subarray(end + 2).toString('hex'), MESSAGE.toString('hex'));
  }
}

T.finish();
