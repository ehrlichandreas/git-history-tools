/* AC-78 -- D20 (Reviewer R1): git-history-rewrite reads the refs once.
 * runRewrite took the tag messages from one `refTips()` read, before the
 * bundle, and the refs to move and their old values from a second read,
 * after the work. A ref changed in between was never checked:
 *  A. an annotated tag created mid-run was re-created with the message
 *     "undefined" glued to its signature, exit 1, every ref already moved;
 *  B. main moved mid-run ended on the old history while the tags moved,
 *     exit 0, every verify line OK.
 * Now one snapshot, taken before anything is read, gives the messages,
 * the refs to move and their old values; a ref that differs from it when
 * the work is done is a refusal, and nothing moves. A `--hook` that
 * changes a ref on its first call stands in for any concurrent writer. */
import fs from 'node:fs';
import path from 'node:path';
import * as H from '../lib/harness.ts';
const T = H.T;

H.requireBin('git-history-rewrite');

const outside = H.freshDir('ac78-files');
const rules = path.join(outside, 'rules.tsv');
fs.writeFileSync(rules, 'alpha\tomega\n');

const CASES: [string, string, string][] = [
  ['a tag created mid-run', 'refs/tags/late', "git -C \"$GHT_REPO\" -c tag.gpgsign=false tag -a late -m 'late message' main~1"],
  ['main moved mid-run', 'refs/heads/main',
    'nc=$(git -C "$GHT_REPO" -c commit.gpgsign=false commit-tree -p main -m three "main^{tree}") && git -C "$GHT_REPO" update-ref refs/heads/main "$nc"'],
  ['a tag deleted mid-run', 'refs/tags/v1', 'git -C "$GHT_REPO" tag -d v1 >/dev/null'],
];

for (const [label, ref, action] of CASES) {
  const gpg = H.setupGpg('ac78');
  if (!gpg) continue;
  const repo = H.initRepo('ac78', gpg);
  H.commit(repo, gpg, 'first', { 'a.txt': 'alpha\n' });
  H.tagSigned(repo, gpg, 'v1', 'release one');
  H.commit(repo, gpg, 'second', { 'a.txt': 'alpha beta\n' });
  H.tagLightweight(repo, gpg, 'light');
  const fired = path.join(outside, 'fired-' + label.replace(/ /g, '-'));
  const hook = path.join(outside, 'hook-' + label.replace(/ /g, '-'));
  fs.writeFileSync(hook, '#!/bin/sh\nif [ ! -e ' + JSON.stringify(fired) + ' ]; then\n  touch ' + JSON.stringify(fired) +
    '\n  ' + action + ' >&2 || exit 9\nfi\n');
  fs.chmodSync(hook, 0o755);
  const refs = () => H.gitRaw(repo, gpg, ['for-each-ref', '--format=%(refname) %(objectname)']);
  const l = 'AC-78 [' + label + ']';

  const r = H.runBin('git-history-rewrite', ['replace', repo, '--rules', rules, '--hook', hook, '--apply'], { gnupgHome: gpg.gnupgHome });
  T.check(l + ': the hook fired', fs.existsSync(fired), '');
  T.exit(l + ': a refusal, exit 1', r, 1);
  T.check(l + ': one stderr line naming the ref', r.stderr.split('\n').length === 2 &&
    r.stderr.startsWith('git-history-rewrite: refs changed during the run (') && r.stderr.includes(ref), r.stderr);
  { const b = H.findBackupBundle(repo);
    T.eq(l + ': stdout is only the backup line (§ 4.1, D23)', r.stdout, b ? 'backup: ' + fs.realpathSync(b) + '\n' : '(no bundle)'); }
  /* What the hook left is what stays: the bundle holds the pre-run refs,
   * and the refs now are exactly the bundle's plus the hook's change. */
  const bundle = H.findBackupBundle(repo);
  T.check(l + ': the backup bundle is kept', bundle !== null, '');
  if (!bundle) continue;
  const bundled = H.bundleListHeads(bundle);
  const now = new Map(refs().split('\n').filter(Boolean).map((x) => x.split(' ') as [string, string]));
  const moved = [...new Set([...Object.keys(bundled), ...now.keys()])].filter((x) => x.startsWith('refs/') && bundled[x] !== now.get(x));
  T.eq(l + ': no ref moved but the one the hook changed', moved.join(' '), ref);
}

T.finish();
