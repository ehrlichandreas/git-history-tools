/* AC-74 -- D20: `git-release-squash apply`/`tail` and `git-history-rewrite
 * replace`/`add-file` build every new object first (commits via
 * `commit-tree`, signed tag objects by hand, as git-sign's resign-* do)
 * and then move every ref in ONE `update-ref --stdin` transaction, each
 * against its old value. They used to move refs one by one (`update-ref`
 * per branch, `git tag -f -s` per tag, which creates the object and moves
 * the ref in one step), so a failure partway through left a half-moved
 * repository and a stack trace. The failure is forced the way AC-55
 * forces it: a pre-existing `<ref>.lock` on the LAST ref to be moved.
 * Then nothing moves, the tool refuses (exit 1, one stderr line), and the
 * backup bundle exists; with the lock gone, the same run succeeds. */
import fs from 'node:fs';
import path from 'node:path';
import * as H from '../lib/harness.ts';
const T = H.T;

H.requireBin('git-release-squash');
H.requireBin('git-history-rewrite');

const outside = H.freshDir('ac74-files');
const rules = path.join(outside, 'rules.tsv');
fs.writeFileSync(rules, 'alpha\tomega\n');
const addSrc = path.join(outside, 'NOTICE');
fs.writeFileSync(addSrc, 'notice\n');

interface Case { label: string; bin: string; args: (repo: string) => string[]; setup: (repo: string, gpg: H.Gpg) => void; lock: string; moves: string[] }
const twoTags = (repo: string, gpg: H.Gpg) => {
  H.commit(repo, gpg, 'first', { 'a.txt': 'alpha\n' });
  H.tagSigned(repo, gpg, 'v1', 'release one');
  H.commit(repo, gpg, 'second', { 'a.txt': 'alpha beta\n' });
  H.tagSigned(repo, gpg, 'v2', 'release two');
};
const CASES: Case[] = [
  { label: 'apply', bin: 'git-release-squash', args: (r) => ['apply', r, '--map', path.join(outside, 'map-' + path.basename(r)), '--apply'],
    setup: twoTags, lock: 'refs/tags/v2', moves: ['refs/heads/main', 'refs/tags/v1', 'refs/tags/v2'] },
  { label: 'tail --tag', bin: 'git-release-squash', args: (r) => ['tail', r, '--tag=v3', '--message=release three', '--apply'],
    setup: (r, g) => { twoTags(r, g); H.commit(r, g, 'third', { 'a.txt': 'three\n' }); },
    lock: 'refs/tags/v3', moves: ['refs/heads/main', 'refs/tags/v3'] },
  { label: 'replace', bin: 'git-history-rewrite', args: (r) => ['replace', r, '--rules', rules, '--apply'],
    setup: twoTags, lock: 'refs/tags/v2', moves: ['refs/heads/main', 'refs/tags/v1', 'refs/tags/v2'] },
  { label: 'add-file', bin: 'git-history-rewrite', args: (r) => ['add-file', r, addSrc, '--apply'],
    setup: twoTags, lock: 'refs/tags/v2', moves: ['refs/heads/main', 'refs/tags/v1', 'refs/tags/v2'] },
];

for (const c of CASES) {
  const gpg = H.setupGpg('ac74-' + c.label.replace(/\W+/g, ''));
  if (!gpg) continue;
  const repo = H.initRepo('ac74-' + c.label.replace(/\W+/g, ''), gpg);
  c.setup(repo, gpg);
  const refsBefore = H.gitRaw(repo, gpg, ['for-each-ref']);
  const lockPath = path.join(repo, '.git', c.lock + '.lock');
  fs.writeFileSync(lockPath, '');

  const r = H.runBin(c.bin, c.args(repo), { gnupgHome: gpg.gnupgHome });
  const l = 'AC-74 [' + c.label + ', ' + c.lock + ' locked]';
  T.exit(l + ': a refusal, exit 1, not a crash', r, 1);
  T.check(l + ': one stderr line, the failed transaction', /^git-[a-z-]+: ref update transaction failed: .*\n$/.test(r.stderr), r.stderr);
  { const b = H.findBackupBundle(repo);
    T.eq(l + ': stdout is only the backup line (§ 4.1, D23)', r.stdout, b ? 'backup: ' + fs.realpathSync(b) + '\n' : '(no bundle)'); }
  T.eq(l + ': NO ref moved, not even the ones before the locked one', H.gitRaw(repo, gpg, ['for-each-ref']), refsBefore);
  T.check(l + ': the backup bundle exists', H.findBackupBundle(repo) !== null);

  fs.rmSync(lockPath);
  for (const b of fs.readdirSync(path.dirname(repo)).filter((n) => n.startsWith(path.basename(repo) + '.backup-'))) {
    fs.rmSync(path.join(path.dirname(repo), b));
  }
  const ok = H.runBin(c.bin, c.args(repo), { gnupgHome: gpg.gnupgHome });
  const l2 = 'AC-74 [' + c.label + ', unlocked]';
  T.exit(l2 + ': exit 0', ok, 0);
  T.check(l2 + ': no verify line FAILED', !/FAILED/.test(ok.stdout) && /verify: signatures: OK/.test(ok.stdout), ok.stdout);
  const after = H.gitRaw(repo, gpg, ['for-each-ref', '--format=%(refname) %(objectname)']);
  for (const ref of c.moves) {
    const was = new RegExp('^[0-9a-f]+ \\w+\\t' + ref + '$', 'm').exec(refsBefore);
    const now = new RegExp('^' + ref + ' ([0-9a-f]+)$', 'm').exec(after);
    T.check(l2 + ': ' + ref + ' moved', now !== null && (was === null || !was[0].startsWith(now[1])), refsBefore + '\n' + after);
  }
  for (const ref of c.moves.filter((x) => x.startsWith('refs/tags/'))) {
    const raw = H.catFile(repo, gpg, ref);
    T.eq(l2 + ': ' + ref + ' is a tag object with 1 signature block', (raw.match(/^-----BEGIN PGP SIGNATURE-----$/mg) || []).length, 1);
    T.eq(l2 + ': git tag -v ' + ref.slice(10) + ' accepts it', H.gitIn(repo, gpg)(['tag', '-v', ref.slice(10)]).status, 0);
    T.eq(l2 + ': ' + ref + "'s own tag header names it", (/^tag (.*)$/m.exec(raw) || [])[1], ref.slice(10));
  }
}

/* `tail --tag` with a message that `git tag`'s cleanup empties: a usage error up front.
 * `git tag -s` used to refuse it only after the branch had moved. */
{
  const gpg = H.setupGpg('ac74-empty');
  if (gpg) {
    const repo = H.initRepo('ac74-empty', gpg);
    H.commit(repo, gpg, 'first', { 'a.txt': 'alpha\n' });
    const refsBefore = H.gitRaw(repo, gpg, ['for-each-ref']);
    for (const apply of [false, true]) {
      const r = H.runBin('git-release-squash', ['tail', repo, '--tag=v1', '--message=  \n# only a comment\n\n'].concat(apply ? ['--apply'] : []),
        { gnupgHome: gpg.gnupgHome });
      const l = 'AC-74 [tail --tag, empty message' + (apply ? ', --apply' : '') + ']';
      T.exit(l + ': usage error, exit 2', r, 2);
      T.eq(l + ': one stderr line', r.stderr, 'git-release-squash: --tag: the tag message is empty\n');
    }
    T.eq('AC-74 [tail --tag, empty message]: no ref moved', H.gitRaw(repo, gpg, ['for-each-ref']), refsBefore);
    T.eq('AC-74 [tail --tag, empty message]: no backup bundle', H.findBackupBundle(repo), null);
  }
}

T.finish();
