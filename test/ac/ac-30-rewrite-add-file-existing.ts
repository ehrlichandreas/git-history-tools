/* AC-30 -- § 3.2: `add-file` replaces an existing blob at the target path
 * in commits that already have one, and adds it fresh in commits that
 * don't; a directory already sitting at that path is a refusal, not a
 * silent overwrite. */
import fs from 'node:fs';
import path from 'node:path';
import * as H from '../lib/harness.ts';
const T = H.T;

H.requireBin('history-rewrite');

const gpg = H.setupGpg('ac30');
if (gpg) {
  const repo = H.initRepo('ac30', gpg);
  H.commit(repo, gpg, 'no LICENSE yet', { 'a.txt': 'one\n' });
  H.commit(repo, gpg, 'has its own old LICENSE', { 'a.txt': 'two\n', 'LICENSE': 'old license text\n' });

  const srcFile = path.join(H.freshDir("ac30-license-src"), "ac30-license-src.txt");
  fs.writeFileSync(srcFile, 'NEW LICENSE TEXT\n');

  const r = H.runBin('history-rewrite', ['add-file', repo, srcFile, '--as', 'LICENSE', '--apply'], { gnupgHome: gpg.gnupgHome });
  T.exit('AC-30 add-file --apply: exit 0', r, 0);
  if (!r.missing) {
    const headSha = H.revParse(repo, gpg, 'HEAD');
    const headLicense = H.catFile(repo, gpg, headSha + ':LICENSE', '-p');
    T.eq('AC-30: the second commit\'s existing LICENSE is replaced with the new content', headLicense, 'NEW LICENSE TEXT\n');

    const log = H.log(repo, gpg, ['--oneline']);
    const firstSha = log.split('\n').filter(Boolean).pop()!.split(' ')[0];
    const firstLicense = H.catFile(repo, gpg, firstSha + ':LICENSE', '-p');
    T.eq('AC-30: the first commit (which had none) now has it added too', firstLicense, 'NEW LICENSE TEXT\n');
  }
}

const gpg2 = H.setupGpg('ac30b');
if (gpg2) {
  const repo2 = H.initRepo('ac30b', gpg2);
  H.commit(repo2, gpg2, 'has a directory at the target path', { 'LICENSE/nested.txt': 'oops, a directory\n' });
  const srcFile2 = path.join(H.freshDir("ac30b-license-src"), "ac30b-license-src.txt");
  fs.writeFileSync(srcFile2, 'NEW LICENSE TEXT\n');
  const r2 = H.runBin('history-rewrite', ['add-file', repo2, srcFile2, '--as', 'LICENSE'], { gnupgHome: gpg2.gnupgHome });
  T.exit('AC-30b: a directory already at the target path is a refusal, not an overwrite', r2, 1);
  if (!r2.missing) T.check('AC-30b: refusal mentions the conflicting path', r2.stderr.includes('LICENSE'), r2.stderr);
}

T.finish();
