/* AC-96 -- § 0 / D21 (Scout N2): every tool sees the objects `git push`
 * sends, not what `refs/replace/*` swaps in. git reads replace refs by
 * default, so a commit with a secret, hidden behind `git replace <it>
 * <clean>`, was not scanned, yet a push of the branch still sends it.
 * ght now runs every git call with GIT_NO_REPLACE_OBJECTS=1, set after
 * the caller's environment is stripped. So `scan` reports the hidden
 * secret, and `replace` and `tail` rewrite the real commits and trees,
 * not their replacements. */
import fs from 'node:fs';
import path from 'node:path';
import * as H from '../lib/harness.ts';
const T = H.T;

for (const b of ['git-leak-scan', 'git-history-rewrite', 'git-release-squash']) H.requireBin(b);

const outside = H.freshDir('ac96-files');
const rules = path.join(outside, 'rules.tsv');
fs.writeFileSync(rules, 'alpha\tomega\n');
const SECRET = 'API_KEY=AbCdEfGhIjKlMnOpQrStUv12';

/** A clean stand-in for HEAD (same parent, other content), installed with `git replace`. */
function replaceHead(repo: string, gpg: H.Gpg, content: string): void {
  const git = H.gitIn(repo, gpg);
  const real = H.revParse(repo, gpg, 'HEAD');
  const blob = String(git(['hash-object', '-w', '--stdin'], { input: content }).stdout).trim();
  const tree = String(git(['mktree'], { input: '100644 blob ' + blob + '\ta.txt\n' }).stdout).trim();
  const fake = String(git(['commit-tree', tree, '-p', 'HEAD~1', '-m', 'clean stand-in']).stdout).trim();
  git(['replace', real, fake]);
}
const realGit = (repo: string, gpg: H.Gpg, args: string[]) => H.gitRaw(repo, gpg, ['--no-replace-objects', ...args]).trim();

const gpg = H.setupGpg('ac96');
if (gpg) {
  {
    const repo = H.initRepo('ac96-scan', gpg);
    H.commit(repo, gpg, 'first', { 'a.txt': 'nothing\n' });
    H.commit(repo, gpg, 'second', { 'a.txt': SECRET + '\n' });
    replaceHead(repo, gpg, 'nothing here either\n');
    T.eq('AC-96 [scan] fixture: plain git sees the stand-in', H.gitRaw(repo, gpg, ['show', 'HEAD:a.txt']), 'nothing here either\n');
    const r = H.runBin('git-leak-scan', ['scan', repo], { gnupgHome: gpg.gnupgHome });
    T.exit('AC-96 [scan]: a hit, exit 1', r, 1);
    T.contains('AC-96 [scan]: the secret behind the replace ref is reported', r.stdout, 'scan: secret ' + SECRET + ' ');
  }
  {
    const repo = H.initRepo('ac96-replace', gpg);
    H.commit(repo, gpg, 'first', { 'a.txt': 'alpha\n' });
    H.commit(repo, gpg, 'second', { 'a.txt': 'alpha beta\n' });
    replaceHead(repo, gpg, 'alpha stand-in\n');
    const r = H.runBin('git-history-rewrite', ['replace', repo, '--rules', rules, '--apply'], { gnupgHome: gpg.gnupgHome });
    T.exit('AC-96 [replace]: exit 0', r, 0);
    T.eq('AC-96 [replace]: the real HEAD was rewritten', realGit(repo, gpg, ['show', 'main:a.txt']), 'omega beta');
    T.eq('AC-96 [replace]: its message is the real one', realGit(repo, gpg, ['log', '-1', '--format=%s', 'main']), 'second');
  }
  {
    const repo = H.initRepo('ac96-tail', gpg);
    H.commit(repo, gpg, 'first', { 'a.txt': 'alpha\n' });
    H.tagSigned(repo, gpg, 'v1', 'release one');
    H.commit(repo, gpg, 'second', { 'a.txt': 'alpha beta\n' });
    const realTree = realGit(repo, gpg, ['rev-parse', 'HEAD^{tree}']);
    replaceHead(repo, gpg, 'alpha stand-in\n');
    const r = H.runBin('git-release-squash', ['tail', repo, '--apply'], { gnupgHome: gpg.gnupgHome });
    T.exit('AC-96 [tail]: exit 0', r, 0);
    T.eq('AC-96 [tail]: the new commit has the real HEAD tree', realGit(repo, gpg, ['rev-parse', 'main^{tree}']), realTree);
  }
}

T.finish();
