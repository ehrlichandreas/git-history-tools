/* AC-102 -- § 0 (D23): a file the caller names that cannot be read is one
 * usage-error line, `<bin>: <flag>: no such file|is a directory|permission
 * denied: <path>`, exit 2. `--message-file=/nonexistent` (squash `tail
 * --tag`, git-sign `commit`/`tag`) and a directory or unreadable file as
 * `--rules`, `--terms`, `--allow` or add-file's `<path>` all crashed with
 * a node stack trace, exit 1. Nothing is written: no bundle, no ref
 * moved, nothing on stdout. */
import fs from 'node:fs';
import path from 'node:path';
import * as H from '../lib/harness.ts';
const T = H.T;

const BINS = ['git-release-squash', 'git-leak-scan', 'git-history-rewrite', 'git-sign'];
for (const b of BINS) H.requireBin(b);

const outside = H.freshDir('ac95-files');
const dir = path.join(outside, 'a-dir');
fs.mkdirSync(dir);
const locked = path.join(outside, 'locked.txt');
fs.writeFileSync(locked, 'x\n');
fs.chmodSync(locked, 0o000);
const canLock = (() => { try { fs.readFileSync(locked); return false; } catch { return true; } })();
const missing = path.join(outside, 'nonexistent');

const KINDS: [string, string][] = [['no such file', missing], ['is a directory', dir]];
if (canLock) KINDS.push(['permission denied', locked]);

let policy = '';
const CASES: [string, string, (repo: string, f: string) => string[]][] = [
  ['git-release-squash', '--message-file', (r, f) => ['tail', r, '--tag=v2', '--message-file=' + f, '--apply']],
  ['git-sign', '--message-file', (r, f) => ['commit', r, '--message-file=' + f, '--date=auto', '--policy=' + policy, '--apply']],
  ['git-sign', '--message-file', (r, f) => ['tag', r, 'v2', '--message-file=' + f, '--date=auto', '--policy=' + policy, '--apply']],
  ['git-history-rewrite', '--rules', (r, f) => ['replace', r, '--rules', f, '--apply']],
  ['git-history-rewrite', '<path>', (r, f) => ['add-file', r, f, '--as', 'x.txt', '--apply']],
  ['git-leak-scan', '--terms', (r, f) => ['scan', r, '--terms', f]],
  ['git-leak-scan', '--allow', (r, f) => ['scan', r, '--allow', f]],
];

const gpg = H.setupGpg('ac95');
if (gpg) {
  policy = H.writePolicy('ac95', { signingKey: gpg.fingerprint, timezone: 'UTC' });
  for (const [bin, label, args] of CASES) {
    for (const [why, file] of KINDS) {
      /* --rules/--terms/--allow/<path> that do not exist were already a
       * usage error with their own message (§ 4.4, § 3.2). */
      if (why === 'no such file' && label !== '--message-file') continue;
      const repo = H.initRepo('ac95', gpg);
      H.commit(repo, gpg, 'first', { 'a.txt': 'alpha\n' });
      H.tagSigned(repo, gpg, 'v1', 'release one');
      H.commit(repo, gpg, 'second', { 'a.txt': 'alpha beta\n' });
      const refs = () => H.gitRaw(repo, gpg, ['for-each-ref', '--format=%(refname) %(objectname)']);
      const before = refs();
      const a = args(repo, file);
      const l = 'AC-102 [' + bin + ' ' + a[0] + ' ' + label + ', ' + why + ']';

      const r = H.runBin(bin, a, { gnupgHome: gpg.gnupgHome });
      T.exit(l + ': a usage error, exit 2', r, 2);
      T.eq(l + ': one stderr line', r.stderr, bin + ': ' + label + ': ' + why + ': ' + file + '\n');
      T.eq(l + ': nothing on stdout', r.stdout, '');
      T.eq(l + ': no ref moved', refs(), before);
      T.eq(l + ': no backup bundle', H.findBackupBundle(repo), null);
    }
  }
}
fs.chmodSync(locked, 0o600);

T.finish();
