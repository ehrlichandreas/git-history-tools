/* AC-18 -- § 2.1: built-in categories (email, url, local-path, hostname,
 * ip, secret) each produce one "scan: <category> <match> (<count>) first
 * at <short-sha>:<path>" line; exit 0 clean, exit 1 on any hit. */
import fs from 'node:fs';
import path from 'node:path';
import * as H from '../lib/harness.ts';
const T = H.T;

H.requireBin('git-leak-scan');

const gpg = H.setupGpg('ac18');
if (gpg) {
  const repo = H.initRepo('ac18', gpg);
  const c1 = H.commit(repo, gpg, 'add leaky file', {
    'leak.txt':
      'contact jdoe@internal.example for help\n' +
      'see https://example.invalid/internal/docs\n' +
      'path was /Users/jdoe/project/secret-corp\n' +
      'host build01.corp.example reported\n' +
      'ip 203.0.113.7 observed\n' +
      'token=abcdefghijklmnopqrstuvwx leaked here\n',
  });
  const short = H.shortSha(repo, gpg, c1.sha!);

  const r = H.runBin('git-leak-scan', ['scan', repo], { gnupgHome: gpg.gnupgHome });
  T.exit('AC-18 scan: hits found, exit 1', r, 1);
  if (!r.missing) {
    const want = [
      'scan: email jdoe@internal.example (1) first at ' + short + ':leak.txt',
      'scan: url https://example.invalid/internal/docs (1) first at ' + short + ':leak.txt',
      'scan: local-path /Users/jdoe/project/secret-corp (1) first at ' + short + ':leak.txt',
      'scan: hostname build01.corp.example (1) first at ' + short + ':leak.txt',
      'scan: ip 203.0.113.7 (1) first at ' + short + ':leak.txt',
      'scan: secret token=abcdefghijklmnopqrstuvwx (1) first at ' + short + ':leak.txt',
    ];
    for (const line of want) T.contains('AC-18: ' + line, r.stdout, line);
  }
}

const gpg2 = H.setupGpg('ac18b');
if (gpg2) {
  const repo2 = H.initRepo('ac18b', gpg2);
  H.commit(repo2, gpg2, 'clean file', { 'a.txt': 'nothing sensitive here\n' });
  /* The fixture's own committer identity (H.FIXTURE_EMAIL) is itself
   * email-shaped, so it is a legitimate "email" hit in every commit --
   * allowlist it to test an otherwise-clean repo, not an artifact of the
   * fixture's own throwaway identity. */
  const allowFile = path.join(H.freshDir("ac18b-allow"), "ac18b-allow.txt");
  fs.writeFileSync(allowFile, H.FIXTURE_EMAIL + '\n');
  const clean = H.runBin('git-leak-scan', ['scan', repo2, '--allow', allowFile], { gnupgHome: gpg2.gnupgHome });
  T.exit('AC-18b scan on a clean repo: exit 0', clean, 0);
  if (!clean.missing) T.eq('AC-18b: no output on a clean scan', clean.stdout.trim(), '');
}

T.finish();
