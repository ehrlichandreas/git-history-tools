/* AC-88 -- § 2.1 / D22: `local-path` also finds `/root/…`, a
 * `c:\users\…` in any case, and `~<name>/…`, which names a user. A bare
 * `~/…` names no one and stays quiet, as do a `/root/` inside a longer
 * path or a URL, a lowercase `/users/` (a URL path, not macOS), and a
 * `~` inside a word. */
import fs from 'node:fs';
import path from 'node:path';
import * as H from '../lib/harness.ts';
const T = H.T;

H.requireBin('git-leak-scan');

const POSITIVE: [string, string][] = [
  ['key at /root/.ssh/id_ed25519 here', '/root/.ssh/id_ed25519'],
  ['cd c:\\users\\jdoe\\project', 'c:\\users\\jdoe\\project'],
  ['C:\\USERS\\JDOE\\notes.txt', 'C:\\USERS\\JDOE\\notes.txt'],
  ['see ~jdoe/notes.txt', '~jdoe/notes.txt'],
  ['config in ~build_bot/.config/app', '~build_bot/.config/app'],
  /* The old three are unchanged. */
  ['/home/jdoe/src', '/home/jdoe/src'],
  ['/Users/jdoe/src', '/Users/jdoe/src'],
  ['C:\\Users\\jdoe\\src', 'C:\\Users\\jdoe\\src'],
];

const NEGATIVE: string[] = [
  'edit ~/.bashrc first',
  'cd ~/project && make',
  'mounted at /srv/root/data',
  'GET /users/123 returns the user',
  'a~b/c is not a home directory',
  'strike ~~old/new~~ through',
  'C:\\Windows\\System32',
];

const gpg = H.setupGpg('ac88');
if (gpg) {
  const allow = path.join(H.freshDir('ac88-allow'), 'allow.txt');
  fs.writeFileSync(allow, H.FIXTURE_EMAIL + '\n');

  const repo = H.initRepo('ac88', gpg);
  const c = H.commit(repo, gpg, 'paths', { 'paths.txt': POSITIVE.map(([l]) => l + '\n').join('') });
  const short = H.shortSha(repo, gpg, c.sha!);
  const r = H.runBin('git-leak-scan', ['scan', repo, '--allow', allow], { gnupgHome: gpg.gnupgHome });
  T.exit('AC-88: hits found, exit 1', r, 1);
  const lines = r.stdout.split('\n').filter(Boolean);
  for (const [line, match] of POSITIVE) {
    T.check('AC-88 [found]: ' + line, lines.includes('scan: local-path ' + match + ' (1) first at ' + short + ':paths.txt'),
      'want "' + match + '" in:\n' + r.stdout);
  }
  T.eq('AC-88: one line per positive, nothing else', lines.length, POSITIVE.length);

  for (const line of NEGATIVE) {
    const one = H.initRepo('ac88-neg', gpg);
    H.commit(one, gpg, 'one line', { 'clean.txt': line + '\n' });
    const n = H.runBin('git-leak-scan', ['scan', one, '--allow', allow], { gnupgHome: gpg.gnupgHome });
    T.check('AC-88 [not found]: ' + line, n.status === 0 && n.stdout === '', n.status + ' ' + n.stdout + n.stderr);
  }
}

T.finish();
