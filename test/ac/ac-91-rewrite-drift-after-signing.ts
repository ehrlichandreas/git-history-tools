/* AC-91 -- D20 (Reviewer R1b): the drift check runs after the last tag is
 * signed. AC-78's check ran before the tag loop, and signing can take
 * seconds (pinentry, a smartcard), so a ref created or moved while a tag
 * was being signed was in neither the snapshot nor the transaction: W1, a
 * branch created then, stayed on the old history -- exit 0, verify OK,
 * the replaced text still reachable from it. The repo's gpg.program here
 * is a wrapper that changes a ref while it signs the first tag object
 * (`-bsau`, input starting `object `), then signs with gpg: W1 creates a
 * branch, W2 moves main. Both are now the drift refusal, nothing moved.
 * W3/W4 guard the re-read after the transaction (below). */
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import * as H from '../lib/harness.ts';
const T = H.T;

H.requireBin('git-history-rewrite');

const outside = H.freshDir('ac91-files');
const rules = path.join(outside, 'rules.tsv');
fs.writeFileSync(rules, 'alpha\tomega\n');

const CASES: [string, string, string][] = [
  ['W1, a branch created while signing', 'refs/heads/late created', 'git -C "$REPO" branch late main'],
  ['W2, main moved while signing', 'refs/heads/main moved',
    'nc=$(git -C "$REPO" -c commit.gpgsign=false commit-tree -p main -m three "main^{tree}") && git -C "$REPO" update-ref refs/heads/main "$nc"'],
];

for (const [label, drift, action] of CASES) {
  const gpg = H.setupGpg('ac91');
  if (!gpg) continue;
  const repo = H.initRepo('ac91', gpg);
  H.commit(repo, gpg, 'first', { 'a.txt': 'alpha\n' });
  H.tagSigned(repo, gpg, 'v1', 'release one');
  H.commit(repo, gpg, 'second', { 'a.txt': 'alpha beta\n' });
  const fired = path.join(outside, 'fired-' + label.slice(0, 2));
  const wrapper = path.join(outside, 'gpg-' + label.slice(0, 2));
  fs.writeFileSync(wrapper, [
    '#!/bin/bash',
    'REPO=' + JSON.stringify(repo),
    'in=$(mktemp ' + JSON.stringify(path.join(outside, 'in-XXXXXX')) + '); cat > "$in"',
    'if [ "$(head -c 7 "$in")" = "object " ] && [[ " $* " == *" -bsau "* ]] && [ ! -e ' + JSON.stringify(fired) + ' ]; then',
    '  touch ' + JSON.stringify(fired),
    '  ' + action + ' >&2',
    'fi',
    'exec gpg "$@" < "$in"',
    '',
  ].join('\n'));
  fs.chmodSync(wrapper, 0o755);
  H.gitIn(repo, gpg)(['config', 'gpg.program', wrapper]);
  const refs = () => H.gitRaw(repo, gpg, ['for-each-ref', '--format=%(refname) %(objectname)']);
  const l = 'AC-91 [' + label + ']';

  const r = H.runBin('git-history-rewrite', ['replace', repo, '--rules', rules, '--apply'], { gnupgHome: gpg.gnupgHome });
  T.check(l + ': the wrapper fired during tag signing', fs.existsSync(fired), '');
  T.exit(l + ': a refusal, exit 1', r, 1);
  T.check(l + ': one stderr line, the drift refusal naming the ref', r.stderr.split('\n').length === 2 &&
    r.stderr.startsWith('git-history-rewrite: refs changed during the run (') && r.stderr.includes(drift), r.stderr);
  { const b = H.findBackupBundle(repo);
    T.eq(l + ': stdout is only the backup line (§ 4.1, D23)', r.stdout, b ? 'backup: ' + fs.realpathSync(b) + '\n' : '(no bundle)'); }
  const bundle = H.findBackupBundle(repo);
  T.check(l + ': the backup bundle is kept', bundle !== null, '');
  if (!bundle) continue;
  const bundled = H.bundleListHeads(bundle);
  const now = new Map(refs().split('\n').filter(Boolean).map((x) => x.split(' ') as [string, string]));
  const moved = [...new Set([...Object.keys(bundled), ...now.keys()])].filter((x) => x.startsWith('refs/') && bundled[x] !== now.get(x));
  T.eq(l + ': no ref moved but the one the wrapper changed', moved.join(' '), drift.split(' ')[0]);
}

/* The re-read after the transaction (Reviewer's window3.sh): a `git`
 * first on PATH creates a branch right before it hands `update-ref
 * --stdin` to the real git, i.e. after the drift check. That branch is in
 * neither the snapshot nor the transaction: named on stderr, exit 1, the
 * rest of the run done and verified. "still on the old history" only when
 * it points at a commit the run rewrote; a branch on an unrelated commit
 * is just "created during the run". */
const realGit = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
const LATE: [string, string, string][] = [
  ['W3, a branch on the old main', '"$REAL" -C "$repo" branch late main', 'refs/heads/late created during the run, still on the old history'],
  ['W4, a branch on an unrelated commit', 'c=$("$REAL" -C "$repo" commit-tree -S -m orphan 4b825dc642cb6eb9a060e54bf8d69288fbee4904) && "$REAL" -C "$repo" branch late "$c"',
    'refs/heads/late created during the run'],
];
for (const [label, action, line] of LATE) {
  const gpg = H.setupGpg('ac91');
  if (!gpg) continue;
  const repo = H.initRepo('ac91', gpg);
  H.commit(repo, gpg, 'first', { 'a.txt': 'alpha\n' });
  H.tagSigned(repo, gpg, 'v1', 'release one');
  H.commit(repo, gpg, 'second', { 'a.txt': 'alpha beta\n' });
  const binDir = H.freshDir('ac91-path');
  const armed = path.join(binDir, 'armed');
  fs.writeFileSync(path.join(binDir, 'git'), [
    '#!/bin/bash',
    'REAL=' + JSON.stringify(realGit),
    'if [[ " $* " == *" update-ref "*"--stdin"* ]] && [ ! -e ' + JSON.stringify(armed) + ' ]; then',
    '  touch ' + JSON.stringify(armed),
    '  repo=$2',
    '  ' + action + ' >&2',
    'fi',
    'exec "$REAL" "$@"',
    '',
  ].join('\n'));
  fs.chmodSync(path.join(binDir, 'git'), 0o755);
  const l = 'AC-91 [' + label + ']';
  const before = H.gitRaw(repo, gpg, ['rev-parse', 'refs/heads/main']).trim();

  const r = H.runBin('git-history-rewrite', ['replace', repo, '--rules', rules, '--apply'],
    { gnupgHome: gpg.gnupgHome, env: { PATH: binDir + ':' + process.env.PATH } });
  T.check(l + ': the wrapper fired before the transaction', fs.existsSync(armed), '');
  T.exit(l + ': exit 1', r, 1);
  T.eq(l + ': one stderr line naming the late ref', r.stderr, 'git-history-rewrite: ' + line + '\n');
  T.check(l + ': every verify line OK', /verify: tree delta: OK/.test(r.stdout) && /verify: signatures: OK/.test(r.stdout) && !/FAILED/.test(r.stdout), r.stdout);
  T.check(l + ': main moved', H.gitRaw(repo, gpg, ['rev-parse', 'refs/heads/main']).trim() !== before, '');
  T.check(l + ': late exists', H.gitIn(repo, gpg)(['rev-parse', '--verify', '-q', 'refs/heads/late']).status === 0, '');
}

T.finish();
