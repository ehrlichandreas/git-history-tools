'use strict';
/*
 * Generalised signer wrapper (D1's shared rule: a signature can't predate
 * its own key, so every signing operation is pinned to the signing key's
 * own creation time + 60s, never to the --dates=anon 1970 placeholder or to
 * "now"). No hard-coded key id, path or time anywhere: the signing key comes
 * from the repo's own git config, and its creation time is read from gpg.
 * The wrapper script is generated fresh per run in a mkdtemp directory and
 * execs the repo's own configured gpg.program (default "gpg") with
 * --faked-system-time; it never sets GNUPGHOME itself, so the caller's own
 * GNUPGHOME (inherited from the environment the wrapper is spawned in)
 * governs which keyring is used.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const git = require('./git.js');
const { Refusal } = require('./cli.js');

function shQuote(s) {
  return '\'' + String(s).replace(/'/g, '\'\\\'\'') + '\'';
}

/** Reads the signing key's own creation time (unix seconds) via
 * `gpg --list-keys --with-colons <key>`'s pub line, field 6. */
function keyCreationTime(gpgProgram, signingKey, env) {
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

/**
 * Sets up a throwaway signer wrapper for <repo>. `env` is the environment
 * git/gpg should run under (must carry the caller's own GNUPGHOME, if any).
 * Returns { gitConfig: ['-c', 'gpg.program=' + wrapperPath], signTime,
 * cleanup() }.
 */
function createSigner(repo, env) {
  const gpgProgram = git.configGet(repo, 'gpg.program', { env }) || 'gpg';
  const signingKey = git.configGet(repo, 'user.signingkey', { env });
  if (!signingKey) throw new Refusal('no user.signingkey configured for ' + repo);
  const created = keyCreationTime(gpgProgram, signingKey, env);
  const signTime = created + 60;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ght-signer-'));
  const wrapperPath = path.join(dir, 'gpg-wrapper.sh');
  fs.writeFileSync(wrapperPath,
    '#!/bin/sh\n' +
    'exec ' + shQuote(gpgProgram) + ' --faked-system-time ' + signTime + '! "$@"\n');
  fs.chmodSync(wrapperPath, 0o755);

  return {
    gitConfig: ['-c', 'gpg.program=' + wrapperPath],
    signTime,
    cleanup() { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* best effort */ } },
  };
}

module.exports = { createSigner, keyCreationTime };
