/* AC-76 -- D17/D20: wherever a tool pins `gpg.program`, it also pins
 * `gpg.format=openpgp` and blanks `gpg.ssh.program` and
 * `gpg.x509.program`, so a repository's own config can never make git run
 * another signing program. Only `gpg.program` was pinned: with a repo
 * `gpg.format=ssh` plus `gpg.ssh.program=<script>`, `git-sign commit
 * --apply` signed through the repo's script, and the read-only `git-sign
 * check` ran it (git picks the verifier from the signature's own armor,
 * so an SSH- or X.509-armored signature in a foreign history runs
 * `gpg.ssh.program`/`gpg.x509.program` whatever gpg.format says). The
 * same pin now covers git-release-squash's and git-history-rewrite's
 * signing calls. Each case puts a marker script in the repo config and
 * checks it never ran. */
import fs from 'node:fs';
import path from 'node:path';
import * as H from '../lib/harness.ts';
const T = H.T;

H.requireBin('git-sign');
H.requireBin('git-release-squash');
H.requireBin('git-history-rewrite');

/* A repo config that would run `marker` for any SSH or X.509 signing or verification. */
function hostileConfig(repo: string, gpg: H.Gpg, marker: string) {
  const dir = H.freshDir('ac76-scripts');
  const script = path.join(dir, 'signer.sh');
  fs.writeFileSync(script, '#!/bin/sh\necho "ran $*" >> ' + JSON.stringify(marker) + '\nexit 1\n');
  fs.chmodSync(script, 0o755);
  const allowed = path.join(dir, 'allowed_signers');
  fs.writeFileSync(allowed, '');
  const git = H.gitIn(repo, gpg);
  git(['config', 'gpg.format', 'ssh']);
  git(['config', 'gpg.ssh.program', script]);
  git(['config', 'gpg.ssh.allowedSignersFile', allowed]);
  git(['config', 'gpg.x509.program', script]);
}

/* A copy of HEAD whose gpgsig is an SSH- or X.509-armored block, as main's new tip. */
function foreignSignedTip(repo: string, gpg: H.Gpg, kind: 'SSH SIGNATURE' | 'SIGNED MESSAGE') {
  const git = H.gitIn(repo, gpg);
  const raw = H.catFile(repo, gpg, 'HEAD', 'commit');
  const body = raw.replace(/^gpgsig [\s\S]*?\n(?! )/m, '');
  const header = body.slice(0, body.indexOf('\n\n'));
  const rest = body.slice(body.indexOf('\n\n'));
  const sig = 'gpgsig -----BEGIN ' + kind + '-----\n U1NIU0lHAAAAAQ==\n -----END ' + kind + '-----';
  const obj = (git(['hash-object', '-t', 'commit', '-w', '--stdin'], { input: header + '\n' + sig + rest }).stdout || '').trim();
  git(['update-ref', 'refs/heads/main', obj]);
  return obj;
}

const outside = H.freshDir('ac76-files');
const rules = path.join(outside, 'rules.tsv');
fs.writeFileSync(rules, 'alpha\tomega\n');

/* 1. git-sign check over SSH- and X.509-signed commits. */
for (const kind of ['SSH SIGNATURE', 'SIGNED MESSAGE'] as const) {
  const gpg = H.setupGpg('ac76-check');
  if (!gpg) continue;
  const repo = H.initRepoNoSignConfig('ac76-check', gpg);
  H.gitIn(repo, gpg)(['-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'first']);
  foreignSignedTip(repo, gpg, kind);
  const marker = path.join(outside, 'marker-check-' + kind.replace(' ', '-'));
  hostileConfig(repo, gpg, marker);
  const policy = H.writePolicy('ac76-check', { signingKey: gpg.fingerprint });
  const r = H.runBin('git-sign', ['check', repo, 'HEAD', '--policy=' + policy], { gnupgHome: gpg.gnupgHome });
  const l = 'AC-76 [check, ' + kind + ' signature]';
  T.exit(l + ': a violation, exit 1', r, 1);
  T.contains(l + ': the signature is reported, not trusted', r.stdout, ' signature ');
  T.eq(l + ': the repo\'s gpg.ssh.program/gpg.x509.program never ran', fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8') : '', '');
}

/* 2. git-sign commit --apply in a repo configured for SSH signing. */
{
  const gpg = H.setupGpg('ac76-commit');
  if (gpg) {
    const repo = H.initRepoNoSignConfig('ac76-commit', gpg);
    const marker = path.join(outside, 'marker-commit');
    hostileConfig(repo, gpg, marker);
    const policy = H.writePolicy('ac76-commit', { signingKey: gpg.fingerprint });
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
    H.gitIn(repo, gpg)(['add', 'a.txt']);
    const r = H.runBin('git-sign', ['commit', repo, '--message=first', '--date=2026-01-05T12:00Z', '--policy=' + policy, '--apply'],
      { gnupgHome: gpg.gnupgHome });
    T.exit('AC-76 [commit --apply, gpg.format=ssh]: signs with the policy key, exit 0', r, 0);
    T.eq('AC-76 [commit --apply, gpg.format=ssh]: the repo\'s gpg.ssh.program never ran', fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8') : '', '');
    T.contains('AC-76 [commit --apply, gpg.format=ssh]: an OpenPGP signature', H.catFile(repo, gpg, 'HEAD', 'commit'), '-----BEGIN PGP SIGNATURE-----');
  }
}

/* 3. git-release-squash tail --apply and git-history-rewrite replace --apply. */
for (const [label, bin, args] of [
  ['tail --apply', 'git-release-squash', (repo: string) => ['tail', repo, '--tag=v2', '--message=release two', '--apply']],
  ['replace --apply', 'git-history-rewrite', (repo: string) => ['replace', repo, '--rules', rules, '--apply']],
] as [string, string, (repo: string) => string[]][]) {
  const gpg = H.setupGpg('ac76-' + bin);
  if (!gpg) continue;
  const repo = H.initRepo('ac76-' + bin, gpg);
  H.commit(repo, gpg, 'first', { 'a.txt': 'alpha\n' });
  H.tagSigned(repo, gpg, 'v1', 'release one');
  H.commit(repo, gpg, 'second', { 'a.txt': 'alpha beta\n' });
  const marker = path.join(outside, 'marker-' + bin);
  hostileConfig(repo, gpg, marker);
  const r = H.runBin(bin, args(repo), { gnupgHome: gpg.gnupgHome });
  const l = 'AC-76 [' + label + ', gpg.format=ssh]';
  T.exit(l + ': signs with gpg, exit 0', r, 0);
  T.contains(l + ': verify: signatures: OK', r.stdout, 'verify: signatures: OK');
  T.eq(l + ': the repo\'s gpg.ssh.program never ran', fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8') : '', '');
  T.contains(l + ': the new tip has an OpenPGP signature', H.catFile(repo, gpg, 'refs/heads/main', 'commit'), '-----BEGIN PGP SIGNATURE-----');
}

T.finish();
