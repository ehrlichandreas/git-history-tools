/* AC-108 -- § 4.2/§ 4.5 (D24): a verify line computed against the newly
 * written objects now runs BEFORE the ref transaction, not after. Before
 * this, `resign-commits --apply`, `apply --apply`, `tail --apply`,
 * `replace --apply` and `add-file --apply` moved every ref first and only
 * then printed their verify lines -- a FAILED one left the refs moved,
 * exit 1, the backup bundle the only way back. Now `tree delta` (every
 * tool) and, for `resign-commits`, `headers preserved`/`parents mapped`/
 * `check (signature/sig-time)` too, are computed right after the new
 * objects exist and checked BEFORE the transaction: any FAILED one is a
 * refusal in the usual D20 shape (exit 1, one stderr line naming the
 * failed check, the backup bundle and any objects already written kept,
 * stdout only the `backup: <path>` line), no ref moved.
 *
 * Forced here by a one-shot `git` wrapper on PATH (the same idiom as
 * AC-91's drift checks): it lets every call through to the real git
 * except the FIRST `rev-parse <sha>^{tree}` after it has seen a
 * `commit-tree` call, which it answers with the empty tree's sha instead
 * -- a valid tree object, just the wrong one, so `tree delta` sees
 * `expected != actual` for a reason with nothing to do with git-sign,
 * git-release-squash or git-history-rewrite's own logic.
 *
 * Q2 follow-up (Scout MUST on ba201494): `signatures` (`apply`, `tail`,
 * `replace`, `add-file`) and, for `apply`, `every commit tagged` moved
 * before the ref transaction too, but checked only against the PLANNED
 * final ref map, not a live one. `apply`/`tail` genuinely leave branches
 * other than the one being squashed untouched, so a FAILED `signatures`
 * there (an unrelated branch's own unsigned commit) is forced below the
 * same way live: by actually building one, no wrapper needed. `replace`/
 * `add-file` re-sign EVERY commit reachable from `--branches --tags`,
 * including an "unrelated" one -- confirmed live (see the Q2 follow-up
 * report) that this particular trigger can no longer reach a FAILED
 * `signatures` there at all, so no leg is added for them; `tree delta`
 * above already exercises their own pre-move path. `resign-commits`'s
 * own `check (signature/sig-time)` was already fully pre-move since Q2
 * (ba201494) -- the leg below pins the exact live misconfiguration Scout
 * found by accident (a policy naming a primary key fingerprint whose
 * only signing-capable key is a subkey, so gpg signs with the subkey and
 * `check` reports `wrong-key`) as a regression guard, not a new fix. */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as H from '../lib/harness.ts';
const T = H.T;

H.requireBin('git-sign');
H.requireBin('git-release-squash');
H.requireBin('git-history-rewrite');

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const realGit = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();

/** A `git` on PATH that forwards every call to the real git, except the
 * first `rev-parse ...^{tree}` seen after a `commit-tree` call: that one
 * answers with the empty tree's sha and never reaches the real git.
 * Fires at most once (the `armed` sentinel), so later, unrelated
 * `^{tree}` reads (if any) are untouched. */
function treeCorruptingGit(label: string): { binDir: string; armed: string } {
  const binDir = H.freshDir('ac108-path-' + label);
  const armed = path.join(binDir, 'armed');
  const seen = path.join(binDir, 'seen-commit-tree');
  fs.writeFileSync(path.join(binDir, 'git'), [
    '#!/bin/bash',
    'REAL=' + JSON.stringify(realGit),
    'if [[ " $* " == *" commit-tree "* ]]; then touch ' + JSON.stringify(seen) + '; fi',
    'if [ -e ' + JSON.stringify(seen) + ' ] && [ ! -e ' + JSON.stringify(armed) + ' ]; then',
    '  last="${@: -1}"',
    '  if [[ " $* " == *" rev-parse "* ]] && [[ "$last" == *\'^{tree}\' ]]; then',
    '    touch ' + JSON.stringify(armed),
    '    echo ' + EMPTY_TREE,
    '    exit 0',
    '  fi',
    'fi',
    'exec "$REAL" "$@"',
    '',
  ].join('\n'));
  fs.chmodSync(path.join(binDir, 'git'), 0o755);
  return { binDir, armed };
}

const outside = H.freshDir('ac108-files');
const rules = path.join(outside, 'rules.tsv');
fs.writeFileSync(rules, 'alpha\tomega\n');
const addSrc = path.join(outside, 'NOTICE');
fs.writeFileSync(addSrc, 'notice\n');

type Setup = (repo: string, gpg: H.Gpg) => void;
const twoCommits: Setup = (repo, gpg) => {
  H.commit(repo, gpg, 'first', { 'a.txt': 'alpha\n' });
  H.commit(repo, gpg, 'second', { 'a.txt': 'alpha beta\n' });
};
const taggedThenUntagged: Setup = (repo, gpg) => {
  H.commit(repo, gpg, 'first', { 'a.txt': 'alpha\n' });
  H.tagSigned(repo, gpg, 'v1', 'release one');
  H.commit(repo, gpg, 'second', { 'a.txt': 'alpha beta\n' });
};
const taggedHead: Setup = (repo, gpg) => {
  H.commit(repo, gpg, 'first', { 'a.txt': 'alpha\n' });
  H.commit(repo, gpg, 'second', { 'a.txt': 'alpha beta\n' });
  H.tagSigned(repo, gpg, 'v1', 'release one');
};

const CASES: [string, string, Setup, (repo: string, policy: string) => string[]][] = [
  ['resign-commits --apply', 'git-sign', twoCommits, (r, p) => ['resign-commits', r, 'HEAD~1..HEAD', '--policy=' + p, '--apply']],
  ['apply --apply', 'git-release-squash', taggedHead,
    (r) => ['apply', r, '--map', path.join(H.freshDir('ac108-map'), 'map.txt'), '--apply']],
  ['tail --apply', 'git-release-squash', taggedThenUntagged, (r) => ['tail', r, '--apply']],
  ['replace --apply', 'git-history-rewrite', twoCommits, (r) => ['replace', r, '--rules', rules, '--apply']],
  ['add-file --apply', 'git-history-rewrite', twoCommits, (r) => ['add-file', r, addSrc, '--apply']],
];

for (const [label, bin, setup, args] of CASES) {
  const gpg = H.setupGpg('ac108');
  if (!gpg) continue;
  const policy = H.writePolicy('ac108', { signingKey: gpg.fingerprint, timezone: 'UTC' });
  const repo = H.initRepo('ac108-' + label.replace(/\W+/g, '-'), gpg);
  setup(repo, gpg);
  const { binDir, armed } = treeCorruptingGit(label.replace(/\W+/g, '-'));
  const refsBefore = H.gitRaw(repo, gpg, ['for-each-ref', '--format=%(refname) %(objectname)']);
  const l = 'AC-108 [' + label + ']';

  const r = H.runBin(bin, args(repo, policy), { gnupgHome: gpg.gnupgHome, env: { PATH: binDir + ':' + process.env.PATH } });
  T.check(l + ': the wrapper fired (a commit-tree + tree-read happened)', fs.existsSync(armed), '');
  T.exit(l + ': a refusal, exit 1', r, 1);
  T.check(l + ': one stderr line naming the failed check',
    r.stderr.split('\n').length === 2 && r.stderr.includes('tree delta') && r.stderr.includes('FAILED'), r.stderr);
  { const b = H.findBackupBundle(repo);
    T.eq(l + ': stdout is only the backup line', r.stdout, b ? 'backup: ' + fs.realpathSync(b) + '\n' : '(no bundle)'); }
  T.check(l + ': the backup bundle is kept', H.findBackupBundle(repo) !== null, '');
  T.eq(l + ': no ref moved', H.gitRaw(repo, gpg, ['for-each-ref', '--format=%(refname) %(objectname)']), refsBefore);
}

/* ---------------------------------------------- Q2 follow-up legs --- */

/** A second, completely unrelated branch holding one commit that is NOT
 * signed (Scout's own repro): the squash/tail run's own branch and tags
 * stay 100% correct, but `signatures` covers the whole repo, same as
 * before this change -- it must still fail on this branch's commit, now
 * before the ref transaction rather than after. */
function addUnrelatedUnsignedBranch(repo: string, gpg: H.Gpg, name: string): void {
  const git = H.gitIn(repo, gpg);
  git(['checkout', '-q', '-b', name]);
  fs.writeFileSync(path.join(repo, 'unrelated.txt'), 'unrelated\n');
  git(['add', '-A']);
  git(['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'unrelated unsigned']);
  git(['checkout', '-q', 'main']);
}

const SIGNATURE_CASES: [string, string, Setup, (repo: string) => string[]][] = [
  ['apply --apply', 'git-release-squash', taggedHead,
    (r) => ['apply', r, '--map', path.join(H.freshDir('ac108-sig-map'), 'map.txt'), '--apply']],
  ['tail --apply', 'git-release-squash', taggedThenUntagged, (r) => ['tail', r, '--apply']],
];

for (const [label, bin, setup, args] of SIGNATURE_CASES) {
  const gpg = H.setupGpg('ac108-sig');
  if (!gpg) continue;
  const repo = H.initRepo('ac108-sig-' + label.replace(/\W+/g, '-'), gpg);
  setup(repo, gpg);
  addUnrelatedUnsignedBranch(repo, gpg, 'unrelated');
  const refsBefore = H.gitRaw(repo, gpg, ['for-each-ref', '--format=%(refname) %(objectname)']);
  const l = 'AC-108 [' + label + ', unrelated unsigned branch]';

  const r = H.runBin(bin, args(repo), { gnupgHome: gpg.gnupgHome });
  T.exit(l + ': a refusal, exit 1', r, 1);
  T.check(l + ': one stderr line naming signatures FAILED',
    r.stderr.split('\n').length === 2 && r.stderr.includes('signatures') && r.stderr.includes('FAILED'), r.stderr);
  { const b = H.findBackupBundle(repo);
    T.eq(l + ': stdout is only the backup line', r.stdout, b ? 'backup: ' + fs.realpathSync(b) + '\n' : '(no bundle)'); }
  T.check(l + ': the backup bundle is kept', H.findBackupBundle(repo) !== null, '');
  T.eq(l + ': no ref moved (including the unrelated branch)', H.gitRaw(repo, gpg, ['for-each-ref', '--format=%(refname) %(objectname)']), refsBefore);
}

/** A gpg identity whose primary key is cert-only and whose only
 * signing-capable key is a subkey: `--default-key <primary-fpr>` still
 * signs (gpg picks the subkey that actually has the `s` capability), but
 * the signature's own issuer fingerprint is the SUBKEY's -- a different,
 * unrelated 40-hex-char value, not a short form of the primary's. A
 * policy naming the primary fingerprint (the only one an operator would
 * ever write down) is this organically: `keyMatches` sees neither an
 * exact match nor a short-id suffix, so `check` reports `wrong-key`. */
function setupGpgWithSigningSubkey(label: string): H.Gpg | null {
  const gnupgHome = H.freshDir(label + '-home');
  fs.chmodSync(gnupgHome, 0o700);
  const batch = path.join(gnupgHome, 'batch.txt');
  fs.writeFileSync(batch,
    '%no-protection\nKey-Type: RSA\nKey-Length: 2048\nKey-Usage: cert\n' +
    'Subkey-Type: RSA\nSubkey-Length: 2048\nSubkey-Usage: sign\n' +
    'Name-Real: GHT Test\nName-Email: ' + H.FIXTURE_EMAIL + '\nExpire-Date: 0\n%commit\n');
  const env = Object.assign({}, process.env, { GNUPGHOME: gnupgHome });
  const gen = spawnSync('gpg', ['--batch', '--gen-key', batch], { env, encoding: 'utf8', timeout: 30000 });
  if (gen.status !== 0) return null;
  const list = spawnSync('gpg', ['--batch', '--list-secret-keys', '--with-colons'], { env, encoding: 'utf8', timeout: 15000 });
  const m = /^fpr:::::::::([0-9A-F]+):/m.exec(list.stdout || '');
  if (!m) return null;
  return { gnupgHome, fingerprint: m[1], env };
}

{
  const gpg = setupGpgWithSigningSubkey('ac108-subkey');
  if (gpg) {
    const policy = H.writePolicy('ac108-subkey', { signingKey: gpg.fingerprint, timezone: 'UTC' });
    const repo = H.initRepo('ac108-signingkey-mismatch', gpg);
    H.commit(repo, gpg, 'first', { 'a.txt': 'alpha\n' });
    H.commit(repo, gpg, 'second', { 'a.txt': 'alpha beta\n' });
    const refsBefore = H.gitRaw(repo, gpg, ['for-each-ref', '--format=%(refname) %(objectname)']);
    const l = 'AC-108 [resign-commits --apply, signingKey names a subkey-only primary]';

    const r = H.runBin('git-sign', ['resign-commits', repo, 'HEAD~1..HEAD', '--policy=' + policy, '--apply'], { gnupgHome: gpg.gnupgHome });
    T.exit(l + ': a refusal, exit 1', r, 1);
    T.check(l + ': one stderr line naming check FAILED, wrong-key',
      r.stderr.split('\n').length === 2 && r.stderr.includes('check (signature/sig-time)') &&
        r.stderr.includes('FAILED') && r.stderr.includes('not the policy key'), r.stderr);
    { const b = H.findBackupBundle(repo);
      T.eq(l + ': stdout is only the backup line', r.stdout, b ? 'backup: ' + fs.realpathSync(b) + '\n' : '(no bundle)'); }
    T.check(l + ': the backup bundle is kept', H.findBackupBundle(repo) !== null, '');
    T.eq(l + ': no ref moved', H.gitRaw(repo, gpg, ['for-each-ref', '--format=%(refname) %(objectname)']), refsBefore);
  }
}

/* ------------------------------------------- Q2 hardening legs --- */

/* Untouched refs ride the ref transaction as `verify` lines (Reviewer
 * SHOULD on 360babc5): `resign-commits`, `apply` and `tail` each build
 * their planned final ref map from one read of the repo's branches/tags,
 * then do real work (signing, building commits/tags) before the ref
 * transaction -- nothing re-checked an UNTOUCHED ref (one neither the
 * snapshot's own plan nor `moves` ever names) in that window, until now.
 * Forced the same way AC-91's W3/W4 do: a one-shot `git` on PATH that
 * fires on the real `update-ref --stdin` call and moves an untouched
 * branch, `other`, to a fresh orphan commit right before handing off to
 * the real git -- `other`'s own `verify` line (added to the SAME
 * transaction by the fix) then fails git's own atomic check, so NOTHING
 * in that transaction lands: not `other` (already moved by the wrapper
 * itself, a fact outside the transaction, not reverted by it) but none of
 * this run's own planned moves either, exactly the atomicity the fix
 * exists to provide. `replace`/`add-file` have no leg here: every ref
 * reachable from `--branches --tags` is remapped by construction (see
 * the comment in `runRewrite`), so there is no untouched ref to drift. */
function moveOtherBeforeTransaction(label: string): { binDir: string; armed: string } {
  const binDir = H.freshDir('q2-drift-path-' + label);
  const armed = path.join(binDir, 'armed');
  fs.writeFileSync(path.join(binDir, 'git'), [
    '#!/bin/bash',
    'REAL=' + JSON.stringify(realGit),
    'if [[ " $* " == *" update-ref "*"--stdin"* ]] && [ ! -e ' + JSON.stringify(armed) + ' ]; then',
    '  touch ' + JSON.stringify(armed),
    '  repo=$2',
    '  c=$("$REAL" -C "$repo" commit-tree -m orphan ' + EMPTY_TREE + ')',
    '  "$REAL" -C "$repo" update-ref refs/heads/other "$c" >&2',
    'fi',
    'exec "$REAL" "$@"',
    '',
  ].join('\n'));
  fs.chmodSync(path.join(binDir, 'git'), 0o755);
  return { binDir, armed };
}

{
  const gpg = H.setupGpg('q2-drift-resign');
  if (gpg) {
    const policy = H.writePolicy('q2-drift-resign', { signingKey: gpg.fingerprint, timezone: 'UTC' });
    const repo = H.initRepo('q2-drift-resign', gpg);
    H.commit(repo, gpg, 'first', { 'a.txt': 'alpha\n' });
    H.gitIn(repo, gpg)(['branch', 'other']);
    H.commit(repo, gpg, 'second', { 'a.txt': 'alpha beta\n' });
    const { binDir, armed } = moveOtherBeforeTransaction('resign');
    const mainBefore = H.gitRaw(repo, gpg, ['rev-parse', 'refs/heads/main']).trim();
    const otherBefore = H.gitRaw(repo, gpg, ['rev-parse', 'refs/heads/other']).trim();
    const l = 'Q2 [resign-commits --apply, other branch drifts]';

    const r = H.runBin('git-sign', ['resign-commits', repo, 'HEAD~1..HEAD', '--policy=' + policy, '--apply'],
      { gnupgHome: gpg.gnupgHome, env: { PATH: binDir + ':' + process.env.PATH } });
    T.check(l + ': the wrapper fired before the transaction', fs.existsSync(armed), '');
    T.exit(l + ': a refusal, exit 1', r, 1);
    T.check(l + ': stderr names the drifted ref', r.stderr.includes('refs/heads/other'), r.stderr);
    T.eq(l + ': main did not move -- the whole transaction was refused', H.gitRaw(repo, gpg, ['rev-parse', 'refs/heads/main']).trim(), mainBefore);
    T.check(l + ': other moved -- the wrapper\'s own drift, not undone',
      H.gitRaw(repo, gpg, ['rev-parse', 'refs/heads/other']).trim() !== otherBefore, '');
  }
}

{
  const gpg = H.setupGpg('q2-drift-apply');
  if (gpg) {
    const repo = H.initRepo('q2-drift-apply', gpg);
    H.commit(repo, gpg, 'first', { 'a.txt': 'alpha\n' });
    H.gitIn(repo, gpg)(['branch', 'other']);
    H.commit(repo, gpg, 'second', { 'a.txt': 'alpha beta\n' });
    H.tagSigned(repo, gpg, 'v1', 'release one');
    const { binDir, armed } = moveOtherBeforeTransaction('apply');
    const mainBefore = H.gitRaw(repo, gpg, ['rev-parse', 'refs/heads/main']).trim();
    const otherBefore = H.gitRaw(repo, gpg, ['rev-parse', 'refs/heads/other']).trim();
    const l = 'Q2 [apply --apply, other branch drifts]';

    const r = H.runBin('git-release-squash',
      ['apply', repo, '--map', path.join(H.freshDir('q2-drift-apply-map'), 'map.txt'), '--apply'],
      { gnupgHome: gpg.gnupgHome, env: { PATH: binDir + ':' + process.env.PATH } });
    T.check(l + ': the wrapper fired before the transaction', fs.existsSync(armed), '');
    T.exit(l + ': a refusal, exit 1', r, 1);
    T.check(l + ': stderr names the drifted ref', r.stderr.includes('refs/heads/other'), r.stderr);
    T.eq(l + ': main did not move -- the whole transaction was refused', H.gitRaw(repo, gpg, ['rev-parse', 'refs/heads/main']).trim(), mainBefore);
    T.check(l + ': other moved -- the wrapper\'s own drift, not undone',
      H.gitRaw(repo, gpg, ['rev-parse', 'refs/heads/other']).trim() !== otherBefore, '');
  }
}

{
  const gpg = H.setupGpg('q2-drift-tail');
  if (gpg) {
    const repo = H.initRepo('q2-drift-tail', gpg);
    H.commit(repo, gpg, 'first', { 'a.txt': 'alpha\n' });
    H.gitIn(repo, gpg)(['branch', 'other']);
    H.tagSigned(repo, gpg, 'v1', 'release one');
    H.commit(repo, gpg, 'second', { 'a.txt': 'alpha beta\n' });
    const { binDir, armed } = moveOtherBeforeTransaction('tail');
    const mainBefore = H.gitRaw(repo, gpg, ['rev-parse', 'refs/heads/main']).trim();
    const otherBefore = H.gitRaw(repo, gpg, ['rev-parse', 'refs/heads/other']).trim();
    const l = 'Q2 [tail --apply, other branch drifts]';

    const r = H.runBin('git-release-squash', ['tail', repo, '--apply'],
      { gnupgHome: gpg.gnupgHome, env: { PATH: binDir + ':' + process.env.PATH } });
    T.check(l + ': the wrapper fired before the transaction', fs.existsSync(armed), '');
    T.exit(l + ': a refusal, exit 1', r, 1);
    T.check(l + ': stderr names the drifted ref', r.stderr.includes('refs/heads/other'), r.stderr);
    T.eq(l + ': main did not move -- the whole transaction was refused', H.gitRaw(repo, gpg, ['rev-parse', 'refs/heads/main']).trim(), mainBefore);
    T.check(l + ': other moved -- the wrapper\'s own drift, not undone',
      H.gitRaw(repo, gpg, ['rev-parse', 'refs/heads/other']).trim() !== otherBefore, '');
  }
}

T.finish();
