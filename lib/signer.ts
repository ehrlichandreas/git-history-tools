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
import { Refusal } from './cli.ts';

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

function shQuote(s: string): string {
  return '\'' + String(s).replace(/'/g, '\'\\\'\'') + '\'';
}

/** Reads the signing key's own creation time (unix seconds) via
 * `gpg --list-keys --with-colons <key>`'s pub line, field 6. */
export function keyCreationTime(gpgProgram: string, signingKey: string, env: NodeJS.ProcessEnv): number {
  const r = spawnSync(gpgProgram, ['--batch', '--list-keys', '--with-colons', signingKey], { env, encoding: 'utf8' });
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
  const created = keyCreationTime(gpgProgram, signingKey, env);
  const signTime = (opts && opts.signTime !== undefined) ? opts.signTime : created + 60;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ght-signer-'));
  const wrapperPath = path.join(dir, 'gpg-wrapper.sh');
  fs.writeFileSync(wrapperPath,
    '#!/bin/sh\n' +
    'exec ' + shQuote(gpgProgram) + ' --faked-system-time ' + signTime + '! "$@"\n');
  fs.chmodSync(wrapperPath, 0o755);

  const gitConfig = ['-c', 'gpg.program=' + wrapperPath];
  if (explicitKey) gitConfig.push('-c', 'user.signingkey=' + explicitKey);

  return {
    gitConfig,
    signTime,
    gpgProgram: wrapperPath,
    signingKey,
    cleanup() { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* best effort */ } },
  };
}
