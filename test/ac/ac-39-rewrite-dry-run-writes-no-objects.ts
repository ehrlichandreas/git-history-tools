/* AC-39 -- § 0 (D2, commit a4e8b9f): `history-rewrite`'s dry runs write
 * no git objects either -- `.git/objects` must be byte-identical before
 * and after a dry-run `replace`/`add-file` (no --apply), even though
 * `--hook` (when given) is still invoked during a dry run's own tree
 * computation (§ 3.1) -- the hook's OWN writes are the hook's business,
 * but `replace`/`add-file`'s dry-run preview work must not write
 * anything of its own. */
import fs from 'node:fs';
import path from 'node:path';
import * as H from '../lib/harness.ts';
const T = H.T;

H.requireBin('history-rewrite');

function assertNoObjectsWritten(label: string, repo: string, gpg: H.Gpg, args: string[]): void {
  const before = H.objectStoreSnapshot(repo, gpg);
  const r = H.runBin('history-rewrite', args, { gnupgHome: gpg.gnupgHome });
  const after = H.objectStoreSnapshot(repo, gpg);
  T.exit(label + ': exit 0', r, 0);
  if (r.missing) return;
  const diff = H.objectStoreDiff(before, after);
  T.eq(label + ': no new loose objects or packs appeared', diff.added, []);
  T.eq(label + ': no existing object file disappeared', diff.removed, []);
  T.check(label + ': git count-objects -v report is unchanged',
    !diff.countChanged, 'before:\n' + before.countObjects + 'after:\n' + after.countObjects);
}

const gpg = H.setupGpg('ac39');
if (gpg) {
  const repo = H.initRepo('ac39', gpg);
  H.commit(repo, gpg, 'add leak', { 'a.txt': 'jdoe@internal.example\n' });

  const rulesFile = path.join(H.freshDir("ac39-rules"), "ac39-rules.txt");
  fs.writeFileSync(rulesFile, 'jdoe@internal.example\tREDACTED\n');

  assertNoObjectsWritten('AC-39 replace (dry run, no --apply)', repo, gpg,
    ['replace', repo, '--rules', rulesFile]);
}

const gpg2 = H.setupGpg('ac39b');
if (gpg2) {
  const repo2 = H.initRepo('ac39b', gpg2);
  H.commit(repo2, gpg2, 'root', { 'a.txt': 'one\n' });

  const srcFile = path.join(H.freshDir("ac39-addfile-src"), "ac39-addfile-src.txt");
  fs.writeFileSync(srcFile, 'content\n');

  assertNoObjectsWritten('AC-39 add-file (dry run, no --apply)', repo2, gpg2,
    ['add-file', repo2, srcFile, '--as', 'NEWFILE']);
}

T.finish();
