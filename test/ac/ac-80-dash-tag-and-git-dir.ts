/* AC-80 -- D20 (Reviewer nits a, c). (a) A tag named `-x` is a valid
 * refname (`check-ref-format refs/tags/-x` passes; only `git tag` itself
 * refuses to create one), but two calls passed the bare name to `git
 * tag`, which read it as an option: `git-release-squash apply --apply`
 * crashed with `unknown switch 'x'` after the bundle and the new objects,
 * and `git-sign resign-tags --apply` reported `verify: -x: FAILED
 * (signature not accepted)` for a good tag. Both now name the tag by its
 * full refname. (c) `<repo>` given as a repository's `.git` directory was
 * refused as "the top level is unknown"; the refusal now names the work
 * tree. */
import fs from 'node:fs';
import path from 'node:path';
import * as H from '../lib/harness.ts';
const T = H.T;

H.requireBin('git-release-squash');
H.requireBin('git-sign');
H.requireBin('git-history-rewrite');

/* A repo whose only tag is an annotated `-x`, written by hand. */
function dashTagRepo(gpg: H.Gpg): string {
  const repo = H.initRepo('ac80', gpg);
  const c = H.commit(repo, gpg, 'one', { 'a.txt': 'a\n' });
  const git = H.gitIn(repo, gpg);
  const obj = (git(['hash-object', '-t', 'tag', '-w', '--stdin'], {
    input: 'object ' + c.sha + '\ntype commit\ntag -x\ntagger GHT Test <' + H.FIXTURE_EMAIL + '> 1000000000 +0000\n\nrelease x\n',
  }).stdout as string).trim();
  git(['update-ref', 'refs/tags/-x', obj]);
  return repo;
}

const outside = H.freshDir('ac80-files');

{
  const gpg = H.setupGpg('ac80-apply');
  if (gpg) {
    const repo = dashTagRepo(gpg);
    const before = H.revParse(repo, gpg, 'refs/tags/-x');
    const r = H.runBin('git-release-squash', ['apply', repo, '--map', path.join(outside, 'map'), '--apply'], { gnupgHome: gpg.gnupgHome });
    T.exit('AC-80 [apply --apply, tag -x]: exit 0', r, 0);
    T.eq('AC-80 [apply --apply, tag -x]: nothing on stderr', r.stderr, '');
    T.check('AC-80 [apply --apply, tag -x]: -x moved', H.revParse(repo, gpg, 'refs/tags/-x') !== before, '');
    const v = H.gitIn(repo, gpg)(['verify-tag', 'refs/tags/-x']);
    T.check('AC-80 [apply --apply, tag -x]: the new -x passes git verify-tag', v.status === 0, v.stderr as string);
    T.contains('AC-80 [apply --apply, tag -x]: its message is kept', H.catFile(repo, gpg, 'refs/tags/-x', 'tag'), '\n\nrelease x\n');
  }
}

{
  const gpg = H.setupGpg('ac80-resign');
  if (gpg) {
    const repo = dashTagRepo(gpg);
    const policy = H.writePolicy('ac80', { signingKey: gpg.fingerprint });
    const r = H.runBin('git-sign', ['resign-tags', repo, '--policy=' + policy, '--apply'], { gnupgHome: gpg.gnupgHome });
    T.exit('AC-80 [resign-tags --apply, tag -x]: exit 0', r, 0);
    T.contains('AC-80 [resign-tags --apply, tag -x]: verify OK', r.stdout, 'verify: -x: OK\n');
  }
}

{
  const gpg = H.setupGpg('ac80-gitdir');
  if (gpg) {
    const repo = H.initRepo('ac80-gitdir', gpg);
    H.commit(repo, gpg, 'one', { 'a.txt': 'a\n' });
    const rules = path.join(outside, 'rules.tsv');
    fs.writeFileSync(rules, 'a\tb\n');
    const dotGit = path.join(repo, '.git');
    const r = H.runBin('git-history-rewrite', ['replace', dotGit, '--rules', rules, '--apply'], { gnupgHome: gpg.gnupgHome });
    T.exit('AC-80 [<repo> is .git]: a refusal, exit 1', r, 1);
    T.eq('AC-80 [<repo> is .git]: the refusal names the work tree', r.stderr,
      'git-history-rewrite: not the top level of its repository (' + dotGit + '; the top level is ' + fs.realpathSync(repo) + ')\n');
  }
}

T.finish();
