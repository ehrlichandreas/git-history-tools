/* AC-05 -- § 0: a merge commit reachable from HEAD is refused by every
 * git-release-squash subcommand (plan, apply, tail) and every git-history-rewrite
 * subcommand, naming the first merge commit found in topo-order. */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as H from '../lib/harness.ts';
const T = H.T;

H.requireBin('git-release-squash');
H.requireBin('git-history-rewrite');

function buildMergeRepo(label: string) {
  const gpg = H.setupGpg(label);
  if (!gpg) return null;
  const repo = H.initRepo(label, gpg);
  H.commit(repo, gpg, 'root', { 'a.txt': 'one\n' });
  const git = H.gitIn(repo, gpg);
  git(['checkout', '-q', '-b', 'side']);
  H.commit(repo, gpg, 'side change', { 'b.txt': 'side\n' });
  git(['checkout', '-q', 'main']);
  H.commit(repo, gpg, 'main change', { 'c.txt': 'main\n' });
  const merge = git(['merge', '--no-ff', '-q', '-m', 'merge side into main', 'side']);
  T.check('AC-05 fixture: merge committed cleanly', merge.status === 0, merge.stderr);
  const mergeSha = H.shortSha(repo, gpg, 'HEAD');
  H.tagSigned(repo, gpg, 'v1', 'release including a merge');
  return { repo, gpg, mergeSha };
}

const fx = buildMergeRepo('ac05');
if (fx) {
  const { repo, gpg, mergeSha } = fx;

  const plan = H.runBin('git-release-squash', ['plan', repo], { gnupgHome: gpg.gnupgHome });
  T.exit('AC-05 plan refuses a merge commit', plan, 1);
  if (!plan.missing) {
    T.contains('AC-05 plan: refusal names "merge commits are not supported"', plan.stderr, 'merge commits are not supported');
    T.contains('AC-05 plan: refusal names the merge commit itself', plan.stderr, mergeSha);
    T.eq('AC-05 plan: nothing on stdout on a refusal', plan.stdout, '');
  }

  const apply = H.runBin('git-release-squash', ['apply', repo, '--map', path.join(H.freshDir("ac05-map-unused"), "ac05-map-unused.txt")], { gnupgHome: gpg.gnupgHome });
  T.exit('AC-05 apply refuses a merge commit', apply, 1);
  if (!apply.missing) T.contains('AC-05 apply: same refusal reason', apply.stderr, 'merge commits are not supported');

  const tail = H.runBin('git-release-squash', ['tail', repo], { gnupgHome: gpg.gnupgHome });
  T.exit('AC-05 tail refuses a merge commit', tail, 1);
  if (!tail.missing) T.contains('AC-05 tail: same refusal reason', tail.stderr, 'merge commits are not supported');

  const rulesFile = path.join(H.freshDir("ac05-rules-unused"), "ac05-rules-unused.txt");
  fs.writeFileSync(rulesFile, 'from\tto\n');
  const replace = H.runBin('git-history-rewrite', ['replace', repo, '--rules', rulesFile], { gnupgHome: gpg.gnupgHome });
  T.exit('AC-05 git-history-rewrite replace refuses a merge commit', replace, 1);
  if (!replace.missing) T.contains('AC-05 replace: same refusal reason', replace.stderr, 'merge commits are not supported');
}

T.finish();
