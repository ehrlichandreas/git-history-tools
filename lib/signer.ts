/*
 * Generalised signer wrapper (D1's shared rule: a signature can't predate
 * its own key, so every signing operation is pinned to the signing key's
 * own creation time + 60s, never to the --dates=anon 1970 placeholder or to
 * "now"). No hard-coded key id, path or time anywhere: the signing key comes
 * from `opts.signingKey` (git-sign: the policy) or else the repo's own
 * `user.signingkey`, and its creation time is read from gpg. The wrapper
 * script is generated fresh per run in a mkdtemp directory and execs
 * `opts.gpgProgram` (git-sign: the policy's, else "gpg") or else the repo's
 * own configured gpg.program (default "gpg") with
 * --faked-system-time; it never sets GNUPGHOME itself, so the caller's own
 * GNUPGHOME (inherited from the environment the wrapper is spawned in)
 * governs which keyring is used.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as git from './git.ts';
import { Refusal, UsageError } from './cli.ts';

export interface Signer {
  gitConfig: string[];
  signTime: number;
  /** The wrapper script itself (execs the real gpg.program with
   * `--faked-system-time`) -- for a caller that needs to invoke gpg
   * directly (e.g. to sign a buffer that isn't going through a `git`
   * command at all), rather than only via `gitConfig`'s `-c
   * gpg.program=...` override. */
  gpgProgram: string;
  /** The resolved signing key (the explicit `opts.signingKey`, or the
   * repo's own configured `user.signingkey`) -- same direct-invocation
   * use case as `gpgProgram` above. */
  signingKey: string;
  cleanup(): void;
}

/** What every pinned `gpg.program` comes with (D20): OpenPGP only, and no
 * SSH or X.509 program to run. */
export const PIN_OTHER_SIGNERS: [string, string][] = [
  ['gpg.format', 'openpgp'],
  ['gpg.ssh.program', ''],
  ['gpg.x509.program', ''],
];

function shQuote(s: string): string {
  return '\'' + String(s).replace(/'/g, '\'\\\'\'') + '\'';
}

/** Reads the signing key's own creation time (unix seconds) via
 * `gpg --list-keys --with-colons <key>`'s pub line, field 6. */
export function keyCreationTime(gpgProgram: string, signingKey: string, env: NodeJS.ProcessEnv): number {
  /* `--`: a key like `--options=<file>` is a key name, not an option (D21, AC-98). */
  const r = spawnSync(gpgProgram, ['--batch', '--list-keys', '--with-colons', '--', signingKey], { env, encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Refusal('could not read the signing key (' + signingKey + ') via ' + gpgProgram +
      ' --list-keys: ' + (r.stderr || '').trim());
  }
  const line = (r.stdout || '').split('\n').find((l) => l.startsWith('pub:'));
  if (!line) throw new Refusal('no pub record for signing key ' + signingKey);
  const fields = line.split(':');
  const created = parseInt(fields[5], 10);
  if (!Number.isFinite(created)) throw new Refusal('could not parse creation time for signing key ' + signingKey);
  return created;
}

export interface SignerOpts {
  /** git-sign (docs/SPECIFICATION.md § 5): never read user.signingkey from
   * the repo's own git config -- the key comes from the policy file, passed
   * here explicitly, and `gitConfig` carries it as a `-c` override so it is
   * never persisted. Omitted (the two original, pre-git-sign callers):
   * unchanged behaviour, reading the repo's own configured signing key. */
  signingKey?: string;
  /** git-sign: the signature time is `max(chosen date, key creation + 60s)`,
   * not always `key creation + 60s` -- passed in explicitly once the caller
   * has resolved the chosen date. Omitted: unchanged `created + 60` default. */
  signTime?: number;
  /** git-sign (§ 5.0): the gpg binary to wrap, from the policy (else
   * `gpg`) -- never git's own `gpg.program`. Omitted (the pre-git-sign
   * callers): unchanged behaviour, the repo's configured gpg.program. */
  gpgProgram?: string;
}

/**
 * Sets up a throwaway signer wrapper for <repo>. `env` is the environment
 * git/gpg should run under (must carry the caller's own GNUPGHOME, if any).
 */
export function createSigner(repo: string, env: NodeJS.ProcessEnv, opts?: SignerOpts): Signer {
  const gpgProgram = (opts && opts.gpgProgram) || git.configGet(repo, 'gpg.program', { env }) || 'gpg';
  const explicitKey = opts && opts.signingKey;
  const signingKey = explicitKey || git.configGet(repo, 'user.signingkey', { env });
  if (!signingKey) throw new Refusal('no user.signingkey configured for ' + repo);
  /* The repo's or the caller's key reaches gpg as an argument; `-bsau <key>`
   * cannot take `--` (it would sign with the key "--"), so refuse here,
   * before any gpg runs (D21, AC-98). */
  if (signingKey.startsWith('-')) {
    throw new UsageError('user.signingkey "' + signingKey + '" starts with "-", which gpg would read as an option; nothing written');
  }
  const created = keyCreationTime(gpgProgram, signingKey, env);
  const signTime = (opts && opts.signTime !== undefined) ? opts.signTime : created + 60;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ght-signer-'));
  let wrapperPath: string;
  try {
    wrapperPath = path.join(dir, 'gpg-wrapper.sh');
    fs.writeFileSync(wrapperPath,
      '#!/bin/sh\n' +
      'exec ' + shQuote(gpgProgram) + ' --faked-system-time ' + signTime + '! "$@"\n');
    fs.chmodSync(wrapperPath, 0o755);
  } catch (e) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e2) { /* best effort */ }
    throw e;
  }

  /* gpg.program alone is not enough (D17, D20, AC-76): with a repo
   * `gpg.format=ssh` git would sign through `gpg.ssh.program` instead, and
   * git picks a verifier from the signature's own armor, so an SSH or
   * X.509 signature runs `gpg.ssh.program`/`gpg.x509.program` whatever
   * gpg.format says. Every signing call is pinned to OpenPGP, and the
   * other two programs are blanked so nothing a repository configures runs. */
  const gitConfig = ['-c', 'gpg.program=' + wrapperPath].concat(PIN_OTHER_SIGNERS.flatMap(([k, v]) => ['-c', k + '=' + v]));
  if (explicitKey) gitConfig.push('-c', 'user.signingkey=' + explicitKey);

  return {
    gitConfig,
    signTime,
    gpgProgram: wrapperPath,
    signingKey,
    cleanup() { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* best effort */ } },
  };
}

/** Signs `text` (a tag's own bytes, everything before the signature)
 * detached+armored, via the SAME gpg invocation `git tag -s` uses
 * internally (`-bsau <key>`) -- but through `signer.gpgProgram` directly
 * (the `--faked-system-time` wrapper `createSigner` already built), not
 * through any `git` command at all, so nothing here ever creates or
 * moves a ref. Refuses, naming gpg's own first stderr line, on failure. */
function signTagTextDetached(signer: Signer, env: NodeJS.ProcessEnv, text: string): string {
  const r = spawnSync(signer.gpgProgram, ['--batch', '--status-fd=2', '-bsau', signer.signingKey], {
    env, input: text, encoding: 'utf8',
  });
  if (r.status !== 0) {
    throw new Refusal('failed to sign tag object: ' + (r.stderr || '').trim().split('\n').pop());
  }
  return r.stdout;
}

/** Builds a brand new, fully signed tag object and writes it as a loose
 * object -- WITHOUT ever creating or moving any ref, unlike `git tag
 * -s`, which always does both in one step. (An earlier version of this
 * fix let `git tag -s`/`-f` create the object under its real name, which
 * incidentally moves the real ref too, then immediately reverted that
 * ref -- not actually atomic: a crash between the two steps leaves that
 * one ref moved, reviewer/Lead-found.) The tag's own text (object/type/
 * tag/tagger/blank line/message) is constructed directly from already-
 * parsed fields -- never from `git tag -s`'s own machinery, and never
 * from a previous signature's bytes (item 0: this is also what keeps a
 * resigned tag at exactly 1 signature block, the message here can never
 * contain stray signature material to begin with). Signed via
 * `signTagTextDetached` above, then written via `git hash-object -t tag
 * -w --stdin`, which -- like `commit-tree` for commits -- never touches
 * any ref either. Returns the new object's sha. Shared by git-sign's
 * resign-* and, since D20, by git-release-squash and git-history-rewrite,
 * which used `git tag -f -s` and so moved each tag ref as they went. */
/** The message a signed tag carries: `message` as is, except that a
 * non-empty one without a trailing newline gets one. git stores a message
 * that way for `git tag -a --cleanup=verbatim -m x`, and a signature
 * appended to it starts mid-line, where git never finds it (D20, Reviewer
 * R2, AC-79): the one exception to keeping a message byte for byte. */
export function signableTagMessage(message: string): string {
  return message !== '' && !message.endsWith('\n') ? message + '\n' : message;
}

export function buildSignedTagObject(repo: string, env: NodeJS.ProcessEnv, signer: Signer,
  args: { object: string; type: string; name: string; taggerLine: string; message: string }): string {
  const text = 'object ' + args.object + '\ntype ' + args.type + '\ntag ' + args.name +
    '\ntagger ' + args.taggerLine + '\n\n' + signableTagMessage(args.message);
  const sig = signTagTextDetached(signer, env, text);
  const full = text + sig;
  const r = git.run(repo, ['hash-object', '-t', 'tag', '-w', '--stdin'], { env, input: full });
  if (r.status !== 0) {
    throw new Refusal('failed to write tag object for ' + args.name + ': ' + (r.stderr as string).trim().split('\n')[0]);
  }
  return (r.stdout as string).trim();
}
