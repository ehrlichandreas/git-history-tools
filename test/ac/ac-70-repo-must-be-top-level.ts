/* AC-70 -- § 0: `<repo>` must be the top level of its repository. A
 * subdirectory of a work tree is a git repository to `rev-parse
 * --git-dir`, and `replace <repo>/sub --apply` used to rewrite the whole
 * history down to that subdirectory's tree (every file outside it gone),
 * report every verify line OK, and leave its backup bundle inside the
 * work tree as an untracked file. Now every subcommand of every tool
 * refuses a subdirectory before reading anything else, naming the top
 * level; the top level itself, given with a trailing slash or through a
 * symlink, still works, and the backup bundle lands next to the top
 * level, never inside it. */
import fs from 'node:fs';
import path from 'node:path';
import * as H from '../lib/harness.ts';
const T = H.T;

H.requireBin('git-history-rewrite');
H.requireBin('git-release-squash');
H.requireBin('git-leak-scan');
H.requireBin('git-sign');

const gpg = H.setupGpg('ac70');
if (gpg) {
  const repo = H.initRepo('ac70', gpg);
  H.commit(repo, gpg, 'first', { 'sub/x': 'hello\n', 'top.txt': 'top-level\n' });
  H.commit(repo, gpg, 'second', { 'sub/y': 'hello2\n' });
  H.tagSigned(repo, gpg, 'v1', 'release one');
  H.commit(repo, gpg, 'third', { 'top.txt': 'top-level 2\n' });
  const sub = path.join(repo, 'sub');
  const outside = H.freshDir('ac70-files');
  const rules = path.join(outside, 'rules.tsv');
  fs.writeFileSync(rules, 'hello\tbye\n');
  const addSrc = path.join(outside, 'NOTICE');
  fs.writeFileSync(addSrc, 'notice\n');
  const map = path.join(outside, 'map.txt');
  const policy = H.writePolicy('ac70', { signingKey: gpg.fingerprint });
  const opts = { gnupgHome: gpg.gnupgHome };

  const refsBefore = H.gitRaw(repo, gpg, ['show-ref']);
  const objectsBefore = H.objectStoreSnapshot(repo, gpg);
  const cases: [string, string[]][] = [
    ['git-history-rewrite', ['replace', sub, '--rules', rules, '--apply']],
    ['git-history-rewrite', ['replace', sub, '--rules', rules]],
    ['git-history-rewrite', ['add-file', sub, addSrc, '--apply']],
    ['git-release-squash', ['plan', sub]],
    ['git-release-squash', ['apply', sub, '--map', map, '--apply']],
    ['git-release-squash', ['tail', sub, '--apply']],
    ['git-leak-scan', ['scan', sub]],
    ['git-sign', ['check', sub, 'HEAD', '--policy=' + policy]],
    ['git-sign', ['commit', sub, '--message=x', '--date=auto', '--policy=' + policy]],
    ['git-sign', ['tag', sub, 'v9', '--message=x', '--date=auto', '--policy=' + policy]],
    ['git-sign', ['resign-tags', sub, '--policy=' + policy, '--apply']],
    ['git-sign', ['resign-commits', sub, 'HEAD~1..HEAD', '--policy=' + policy, '--apply']],
  ];
  for (const [bin, args] of cases) {
    const label = 'AC-70 [' + bin + ' ' + args[0] + (args.includes('--apply') ? ' --apply' : '') + ']';
    const r = H.runBin(bin, args, opts);
    T.exit(label + ': a subdirectory as <repo> is a refusal, exit 1', r, 1);
    T.eq(label + ': one stderr line naming the top level',
      r.stderr, bin + ': not the top level of its repository (' + sub + '; the top level is ' + fs.realpathSync(repo) + ')\n');
    T.eq(label + ': nothing on stdout', r.stdout, '');
  }
  T.eq('AC-70: no ref moved by any of them', H.gitRaw(repo, gpg, ['show-ref']), refsBefore);
  T.eq('AC-70: no object written by any of them', JSON.stringify(H.objectStoreDiff(objectsBefore, H.objectStoreSnapshot(repo, gpg))),
    JSON.stringify({ added: [], removed: [], countChanged: false }));
  T.eq('AC-70: nothing untracked in the work tree (no bundle inside it)', H.gitRaw(repo, gpg, ['status', '--porcelain']), '');
  T.eq('AC-70: no bundle next to the top level either', H.findBackupBundle(repo), null);
  T.eq('AC-70: the map file was never written', fs.existsSync(map), false);

  /* The top level itself still works: with a trailing slash, and through a symlink. */
  const dry = H.runBin('git-history-rewrite', ['replace', repo + '/', '--rules', rules], opts);
  T.exit('AC-70: <repo>/ (trailing slash) is the top level, dry run exit 0', dry, 0);
  const link = path.join(H.freshDir('ac70-link'), 'repo-link');
  fs.symlinkSync(repo, link);
  const viaLink = H.runBin('git-leak-scan', ['scan', link, '--allow', (() => {
    const f = path.join(outside, 'allow.txt'); fs.writeFileSync(f, H.FIXTURE_EMAIL + '\n'); return f;
  })()], opts);
  T.exit('AC-70: a symlink to the top level is the top level, scan exit 0', viaLink, 0);

  /* --apply on the top level: the history keeps every file, the bundle sits next to it. */
  const ap = H.runBin('git-history-rewrite', ['replace', repo, '--rules', rules, '--apply'], opts);
  T.exit('AC-70: replace --apply on the top level exits 0', ap, 0);
  T.eq('AC-70: the history keeps the files outside sub/',
    H.gitRaw(repo, gpg, ['ls-tree', '-r', '--name-only', 'main']), 'sub/x\nsub/y\ntop.txt\n');
  T.eq('AC-70: the rules applied inside sub/', H.gitRaw(repo, gpg, ['show', 'main:sub/x']), 'bye\n');
  /* The rewrite moves refs, not the checkout, so tracked files now differ; only untracked ones matter here. */
  T.eq('AC-70: still nothing untracked in the work tree',
    H.gitRaw(repo, gpg, ['status', '--porcelain']).split('\n').filter((l) => l.startsWith('??')), []);
  const bundle = H.findBackupBundle(repo);
  T.check('AC-70: the backup bundle is next to the top level', bundle !== null && path.dirname(bundle) === path.dirname(repo), String(bundle));
}

T.finish();
