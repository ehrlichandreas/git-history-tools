'use strict';
/* AC-34 -- § 3.1: --hook <script> runs once per DISTINCT resulting root
 * tree, receiving that tree's sha as argv[1] and GHT_REPO=<repo> in its
 * environment; printing a 40-hex sha overrides the tree, printing
 * nothing keeps the rule-rewritten tree, and a non-zero exit (or any
 * other stdout shape) is a refusal naming the hook. */
const fs = require('fs');
const path = require('path');
const H = require('../lib/harness.js');
const T = H.T;

H.requireBin('ght-rewrite');

function writeHook(p, body) {
  fs.writeFileSync(p, '#!/bin/sh\n' + body + '\n');
  fs.chmodSync(p, 0o755);
}

const gpg = H.setupGpg('ac34');
if (gpg) {
  const repo = H.initRepo('ac34', gpg);
  H.commit(repo, gpg, 'one', { 'a.txt': 'jdoe@internal.example\n' });
  H.commit(repo, gpg, 'two, identical content after replace', { 'a.txt': 'jdoe@internal.example\n' });

  const rulesFile = path.join(H.freshDir("ac34-rules"), "ac34-rules.txt");
  fs.writeFileSync(rulesFile, 'jdoe@internal.example\tREDACTED\n');

  const hookLog = path.join(H.freshDir("ac34-hook-calls"), "ac34-hook-calls.txt");
  try { fs.unlinkSync(hookLog); } catch (e) {}
  const hookPath = path.join(H.freshDir("ac34-hook-noop"), "ac34-hook-noop.sh");
  writeHook(hookPath, 'echo "$1 $GHT_REPO" >> ' + hookLog + '\nexit 0');

  const r = H.runBin('ght-rewrite', ['replace', repo, '--rules', rulesFile, '--hook', hookPath, '--apply'], { gnupgHome: gpg.gnupgHome });
  T.exit('AC-34 replace --apply --hook (noop hook): exit 0', r, 0);
  if (!r.missing) {
    const calls = fs.existsSync(hookLog) ? fs.readFileSync(hookLog, 'utf8').trim().split('\n').filter(Boolean) : [];
    T.eq('AC-34: the hook ran exactly once -- both commits produce the SAME resulting tree', calls.length, 1);
    if (calls.length) {
      const [shaArg, repoArg] = calls[0].split(' ');
      T.check('AC-34: the hook received a 40-hex tree sha as argv[1]', /^[0-9a-f]{40}$/.test(shaArg), shaArg);
      T.eq('AC-34: GHT_REPO in the hook\'s environment is the repo path', repoArg, repo);
    }
  }
}

const gpg2 = H.setupGpg('ac34b');
if (gpg2) {
  const repo2 = H.initRepo('ac34b', gpg2);
  H.commit(repo2, gpg2, 'one', { 'a.txt': 'jdoe@internal.example\n' });
  const rulesFile2 = path.join(H.freshDir("ac34b-rules"), "ac34b-rules.txt");
  fs.writeFileSync(rulesFile2, 'jdoe@internal.example\tREDACTED\n');

  const overrideTreeHook = path.join(H.freshDir("ac34b-hook-override"), "ac34b-hook-override.sh");
  /* Prints a fixed, unrelated but VALID empty-tree sha -- proves the
   * hook's own printed sha is what ends up as the commit's tree. */
  writeHook(overrideTreeHook, 'echo 4b825dc642cb6eb9a060e54bf8d69288fbee4904');

  const r2 = H.runBin('ght-rewrite', ['replace', repo2, '--rules', rulesFile2, '--hook', overrideTreeHook, '--apply'], { gnupgHome: gpg2.gnupgHome });
  T.exit('AC-34b replace --apply --hook (overriding hook): exit 0', r2, 0);
  if (!r2.missing) {
    const headSha = H.revParse(repo2, gpg2, 'HEAD');
    T.eq('AC-34b: the commit\'s tree is the hook\'s own printed (empty-tree) sha, not the rule-rewritten one',
      H.treeOf(repo2, gpg2, headSha), '4b825dc642cb6eb9a060e54bf8d69288fbee4904');
  }

  const failingHook = path.join(H.freshDir("ac34b-hook-failing"), "ac34b-hook-failing.sh");
  writeHook(failingHook, 'echo "bad output not a sha"\nexit 3');
  const repo3dir = H.initRepo('ac34c', gpg2);
  H.commit(repo3dir, gpg2, 'one', { 'a.txt': 'jdoe@internal.example\n' });
  const r3 = H.runBin('ght-rewrite', ['replace', repo3dir, '--rules', rulesFile2, '--hook', failingHook, '--apply'], { gnupgHome: gpg2.gnupgHome });
  T.exit('AC-34c: a failing/misbehaving hook is a refusal, repo left unchanged', r3, 1);
  if (!r3.missing) T.contains('AC-34c: refusal names the hook', r3.stderr, failingHook);
}

T.finish();
