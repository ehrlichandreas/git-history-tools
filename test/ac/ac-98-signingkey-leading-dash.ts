/* AC-98 -- § 0 / D21 (Scout, Lead's item 7): a signing key that starts
 * with `-` is refused before gpg runs. `keyCreationTime` passed the key to
 * `gpg --list-keys` as a trailing argument with no `--`, so a repo's (or,
 * since the identity allowlist, the caller's) `user.signingkey` of
 * `--options=<file>` made gpg load that file, and an `agent-program` line
 * in it ran a program of the attacker's choice. git-sign was safe (the
 * policy key is hex); the fallback path of `replace`, `apply` and `tail`
 * was not. Now `createSigner` refuses such a key with exit 2, one stderr
 * line, nothing written and no gpg run (the marker an `agent-program`
 * would write never appears), and `keyCreationTime` puts `--` before the
 * key as a second guard. A mixed-case `User.SigningKey` from the caller's
 * GIT_CONFIG_COUNT passes the allowlist and is refused the same way. */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { keyCreationTime } from '../../lib/signer.ts';
import { Refusal } from '../../lib/cli.ts';
import * as H from '../lib/harness.ts';
const T = H.T;

for (const b of ['git-history-rewrite', 'git-release-squash']) H.requireBin(b);

const outside = H.freshDir('ac98-files');
const marker = path.join(outside, 'marker');
const evil = path.join(outside, 'evil.sh');
fs.writeFileSync(evil, '#!/bin/sh\necho "ran $0" >> \'' + marker + '\'\nexit 1\n');
fs.chmodSync(evil, 0o755);
const conf = path.join(outside, 'evil.conf');
fs.writeFileSync(conf, 'agent-program ' + evil + '\nkeyboxd-program ' + evil + '\nwith-secret\n');
fs.chmodSync(conf, 0o600);
const INJECT = '--options=' + conf;
const rules = path.join(outside, 'rules.tsv');
fs.writeFileSync(rules, 'alpha\tomega\n');

const killAgent = (gnupgHome: string) =>
  spawnSync('gpgconf', ['--kill', 'gpg-agent'], { env: Object.assign({}, process.env, { GNUPGHOME: gnupgHome }) });

/* [label, bin, args, the repo's user.signingkey (null: unset), the caller's GIT_CONFIG_COUNT key/value] */
const CASES: [string, string, (repo: string) => string[], string | null, [string, string] | null][] = [
  ['replace, repo user.signingkey=--options=…', 'git-history-rewrite', (r) => ['replace', r, '--rules', rules, '--apply'], INJECT, null],
  ['tail, repo user.signingkey=--options=…', 'git-release-squash', (r) => ['tail', r, '--tag=v2', '--message=m', '--apply'], INJECT, null],
  ['tail, repo user.signingkey=-k', 'git-release-squash', (r) => ['tail', r, '--apply'], '-k', null],
  ['tail, caller GIT_CONFIG_KEY_0=User.SigningKey', 'git-release-squash', (r) => ['tail', r, '--tag=v2', '--message=m', '--apply'], null, ['User.SigningKey', INJECT]],
];

for (const [label, bin, args, repoKey, callerKey] of CASES) {
  const gpg = H.setupGpg('ac98');
  if (!gpg) continue;
  const repo = H.initRepo('ac98', gpg);
  H.commit(repo, gpg, 'first', { 'a.txt': 'alpha\n' });
  H.tagSigned(repo, gpg, 'v1', 'release one');
  H.commit(repo, gpg, 'second', { 'a.txt': 'alpha beta\n' });
  const git = H.gitIn(repo, gpg);
  if (repoKey === null) git(['config', '--unset', 'user.signingkey']);
  else git(['config', 'user.signingkey', repoKey]);
  const key = repoKey === null ? callerKey![1] : repoKey;
  const refs = () => H.gitRaw(repo, gpg, ['for-each-ref', '--format=%(refname) %(objectname)']);
  const before = refs();
  const objects = H.objectStoreSnapshot(repo, gpg);
  const env: Record<string, string> = callerKey ? { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: callerKey[0], GIT_CONFIG_VALUE_0: callerKey[1] } : {};
  killAgent(gpg.gnupgHome);
  fs.rmSync(marker, { force: true });
  const l = 'AC-98 [' + label + ']';

  const r = H.runBin(bin, args(repo), { gnupgHome: gpg.gnupgHome, env });
  T.exit(l + ': a usage error, exit 2', r, 2);
  T.eq(l + ': one stderr line naming the key', r.stderr,
    bin + ': user.signingkey "' + key + '" starts with "-", which gpg would read as an option; nothing written\n');
  T.eq(l + ': nothing on stdout', r.stdout, '');
  T.check(l + ': gpg never ran the agent-program', !fs.existsSync(marker), fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8') : '');
  T.eq(l + ': no ref moved', refs(), before);
  T.eq(l + ': no backup bundle', H.findBackupBundle(repo), null);
  T.eq(l + ': no object written', H.objectStoreDiff(objects, H.objectStoreSnapshot(repo, gpg)).added.length, 0);
}

/* The second guard on its own: keyCreationTime puts `--` before the key,
 * so gpg takes `--options=…` as a key name, finds none, and runs nothing.
 * Without `--`, this leg runs the agent-program. */
const unitGpg = H.setupGpg('ac98');
if (unitGpg) {
  const home = unitGpg.gnupgHome; // a keyring with a key: gpg only starts the agent to look for its secret
  killAgent(home);
  fs.rmSync(marker, { force: true });
  let threw: unknown = null;
  try {
    keyCreationTime('gpg', INJECT, Object.assign({}, process.env, { GNUPGHOME: home }));
  } catch (e) {
    threw = e;
  }
  T.check('AC-98 [keyCreationTime, --options=…]: refused', threw instanceof Refusal, String(threw));
  T.check('AC-98 [keyCreationTime, --options=…]: gpg never ran the agent-program', !fs.existsSync(marker),
    fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8') : '');
  killAgent(home);
}

T.finish();
