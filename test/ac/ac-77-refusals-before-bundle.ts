/* AC-77 -- § 0 / D20: a refusal leaves the repository unchanged and
 * creates no bundle. Several refusals came only after
 * `createBackupBundle`: the signer (no signing key, or a key gpg cannot
 * read) in git-release-squash and git-history-rewrite, add-file's
 * "a directory already exists" check, and in git-sign's resign-* the
 * unreadable policy key and the ambiguous-signature (D18) and malformed
 * tag refusals, and a `--map` path squash apply cannot write (a crash
 * after the bundle, now a usage error). Each now runs before the bundle; this file forces each
 * one on `--apply` and checks for exit 1, one stderr line, no bundle, no
 * object written and no ref moved. */
import fs from 'node:fs';
import path from 'node:path';
import * as H from '../lib/harness.ts';
const T = H.T;

H.requireBin('git-release-squash');
H.requireBin('git-history-rewrite');
H.requireBin('git-sign');

const outside = H.freshDir('ac77-files');
const rules = path.join(outside, 'rules.tsv');
fs.writeFileSync(rules, 'alpha\tomega\n');
const addSrc = path.join(outside, 'NOTICE');
fs.writeFileSync(addSrc, 'notice\n');
const NOT_IN_KEYRING = 'A'.repeat(40);

function expectUntouched(label: string, repo: string, gpg: H.Gpg, r: H.RunBinResult, stderrPart: string,
  before: { refs: string; objects: H.ObjectStoreSnapshot }) {
  T.exit(label + ': a refusal, exit 1', r, 1);
  T.check(label + ': one stderr line, the refusal', r.stderr.split('\n').length === 2 && r.stderr.includes(stderrPart), r.stderr);
  T.eq(label + ': nothing on stdout', r.stdout, '');
  T.eq(label + ': no backup bundle', H.findBackupBundle(repo), null);
  T.eq(label + ': no ref moved', H.gitRaw(repo, gpg, ['for-each-ref']), before.refs);
  T.eq(label + ': no object written', JSON.stringify(H.objectStoreDiff(before.objects, H.objectStoreSnapshot(repo, gpg))),
    JSON.stringify({ added: [], removed: [], countChanged: false }));
}
const snapshot = (repo: string, gpg: H.Gpg) => ({ refs: H.gitRaw(repo, gpg, ['for-each-ref']), objects: H.objectStoreSnapshot(repo, gpg) });

function history(label: string) {
  const gpg = H.setupGpg('ac77-' + label);
  if (!gpg) return null;
  const repo = H.initRepo('ac77-' + label, gpg);
  H.commit(repo, gpg, 'first', { 'a.txt': 'alpha\n', 'NOTICE/keep': 'dir\n' }, { date: '@1000000000 +0000' });
  H.tagSigned(repo, gpg, 'v1', 'release one');
  H.commit(repo, gpg, 'second', { 'a.txt': 'alpha beta\n' }, { date: '@1000086400 +0000' });
  return { gpg, repo };
}

/* 1. git-release-squash / git-history-rewrite: the signing key is missing, or gpg cannot read it. */
for (const [label, bin, args] of [
  ['apply', 'git-release-squash', (r: string) => ['apply', r, '--map', path.join(outside, 'map-' + path.basename(r)), '--apply']],
  ['tail', 'git-release-squash', (r: string) => ['tail', r, '--apply']],
  ['replace', 'git-history-rewrite', (r: string) => ['replace', r, '--rules', rules, '--apply']],
] as [string, string, (r: string) => string[]][]) {
  for (const key of ['unset', 'unreadable']) {
    const h = history(label + '-' + key);
    if (!h) continue;
    const { gpg, repo } = h;
    if (label === 'apply') H.tagSigned(repo, gpg, 'v2', 'release two');
    if (key === 'unset') H.gitIn(repo, gpg)(['config', '--unset', 'user.signingkey']);
    else H.gitIn(repo, gpg)(['config', 'user.signingkey', NOT_IN_KEYRING]);
    const before = snapshot(repo, gpg);
    const r = H.runBin(bin, args(repo), { gnupgHome: gpg.gnupgHome });
    expectUntouched('AC-77 [' + label + ', signing key ' + key + ']', repo, gpg, r,
      key === 'unset' ? 'no user.signingkey configured' : 'could not read the signing key', before);
  }
}

/* 2. add-file: a directory already sits at the path in some commit. */
{
  const h = history('addfile-dir');
  if (h) {
    const before = snapshot(h.repo, h.gpg);
    const r = H.runBin('git-history-rewrite', ['add-file', h.repo, addSrc, '--apply'], { gnupgHome: h.gpg.gnupgHome });
    expectUntouched('AC-77 [add-file, a directory at the path]', h.repo, h.gpg, r, 'a directory already exists at NOTICE', before);
  }
}

/* 2b. git-release-squash apply: a --map path that cannot be written (it was written after the bundle and crashed). */
for (const [label, map, part] of [
  ['no such directory', path.join(outside, 'missing-dir', 'map'), '--map: no such directory: ' + path.join(outside, 'missing-dir')],
  ['a directory', outside, '--map: is a directory: ' + outside],
] as [string, string, string][]) {
  const h = history('map-' + label.replace(/ /g, '-'));
  if (!h) continue;
  H.tagSigned(h.repo, h.gpg, 'v2', 'release two');
  const before = snapshot(h.repo, h.gpg);
  const r = H.runBin('git-release-squash', ['apply', h.repo, '--map', map, '--apply'], { gnupgHome: h.gpg.gnupgHome });
  const l = 'AC-77 [apply, --map is ' + label + ']';
  T.exit(l + ': a usage error, exit 2', r, 2);
  T.eq(l + ': one stderr line naming the path', r.stderr, 'git-release-squash: ' + part + '\n');
  T.eq(l + ': no backup bundle', H.findBackupBundle(h.repo), null);
  T.eq(l + ': no ref moved', H.gitRaw(h.repo, h.gpg, ['for-each-ref']), before.refs);
  T.eq(l + ': no object written', JSON.stringify(H.objectStoreDiff(before.objects, H.objectStoreSnapshot(h.repo, h.gpg))),
    JSON.stringify({ added: [], removed: [], countChanged: false }));
}

/* 3. git-sign resign-tags / resign-commits: the policy key is not in the keyring. */
for (const sub of ['resign-tags', 'resign-commits']) {
  const h = history(sub + '-key');
  if (!h) continue;
  const policy = H.writePolicy('ac77-' + sub, { signingKey: NOT_IN_KEYRING });
  const before = snapshot(h.repo, h.gpg);
  const args = sub === 'resign-tags' ? ['resign-tags', h.repo, 'v1'] : ['resign-commits', h.repo, 'HEAD~1..HEAD'];
  const r = H.runBin('git-sign', args.concat(['--policy=' + policy, '--apply']), { gnupgHome: h.gpg.gnupgHome });
  expectUntouched('AC-77 [' + sub + ', policy key not in the keyring]', h.repo, h.gpg, r, 'could not read the signing key', before);
}

/* 4. git-sign resign-tags / resign-commits: a tag ending in an unverifiable signature-shaped block (D18). */
for (const sub of ['resign-tags', 'resign-commits']) {
  const h = history(sub + '-ambiguous');
  if (!h) continue;
  H.tagAnnotatedUnsigned(h.repo, h.gpg, 'v-quote',
    'advisory, quoted:\n\n-----BEGIN PGP SIGNATURE-----\n\nnot a real signature\n-----END PGP SIGNATURE-----');
  const policy = H.writePolicy('ac77-' + sub + '-amb', { signingKey: h.gpg.fingerprint });
  const before = snapshot(h.repo, h.gpg);
  const args = sub === 'resign-tags' ? ['resign-tags', h.repo, 'v-quote'] : ['resign-commits', h.repo, 'HEAD~1..HEAD'];
  const r = H.runBin('git-sign', args.concat(['--policy=' + policy, '--apply']), { gnupgHome: h.gpg.gnupgHome });
  expectUntouched('AC-77 [' + sub + ', ambiguous tag]', h.repo, h.gpg, r, 'ends with a signature-shaped block', before);
}

T.finish();
