/* AC-81 -- D21 (Scout's attack on 5cfa6f3, N1 + N2): the caller's
 * environment cannot redirect or extend a ght write. git reads GIT_DIR,
 * GIT_WORK_TREE, GIT_OBJECT_DIRECTORY, GIT_CONFIG_PARAMETERS and the rest
 * of `git rev-parse --local-env-vars` before any `-C <repo>`, so:
 *  - `GIT_DIR=B/.git replace A --apply` rewrote B, and left its bundle
 *    next to A;
 *  - `GIT_DIR=A/.git replace A/sub --apply` passed the top-level check
 *    (AC-70) and rewrote A;
 *  - a caller's GIT_CONFIG_PARAMETERS reached every git call (git-sign's
 *    pins only override the keys they name; `user.signingkey` here).
 * Every tool now strips those variables, and GIT_CONFIG_COUNT /
 * GIT_CONFIG_KEY_* / GIT_CONFIG_VALUE_*, from its environment first;
 * `<repo>` alone decides. Of the GIT_CONFIG_COUNT family only the
 * identity comes back (Lead's allowlist): user.name, user.email and
 * user.signingkey, which a release script passes that way; git-sign's
 * policy still wins over them. Running from a git hook keeps working: nothing
 * is refused for being set. The fixed list in lib/git.ts must cover the
 * installed git's own `--local-env-vars`, so a newer git with a new one
 * turns this test red. */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as H from '../lib/harness.ts';
const gitLib: { CALLER_GIT_ENV?: readonly string[] } = await import('../../lib/git.ts');
const CALLER_GIT_ENV = gitLib.CALLER_GIT_ENV || [];
const T = H.T;

H.requireBin('git-history-rewrite');
H.requireBin('git-release-squash');
H.requireBin('git-sign');

const local = (spawnSync('git', ['rev-parse', '--local-env-vars'], { encoding: 'utf8' }).stdout || '').split('\n').filter(Boolean);
T.check('AC-81: git rev-parse --local-env-vars lists something', local.length > 0, '');
T.eq('AC-81: the fixed list covers every --local-env-vars entry', local.filter((v) => !CALLER_GIT_ENV.includes(v)).join(' '), '');

const outside = H.freshDir('ac81-files');
const rules = path.join(outside, 'rules.tsv');
fs.writeFileSync(rules, 'alpha\tomega\n');

function repo(gpg: H.Gpg, label: string): string {
  const r = H.initRepo('ac81-' + label, gpg);
  H.commit(r, gpg, 'first', { 'a.txt': 'alpha\n', 'sub/x': 'alpha x\n' });
  H.tagSigned(r, gpg, 'v1', 'release one');
  H.commit(r, gpg, 'second', { 'a.txt': 'alpha beta\n' });
  return r;
}
const refs = (r: string, gpg: H.Gpg) => H.gitRaw(r, gpg, ['for-each-ref', '--format=%(refname) %(objectname)']);

const gpg = H.setupGpg('ac81');
if (gpg) {
  const opts = (env: Record<string, string>) => ({ gnupgHome: gpg.gnupgHome, env });

  /* 1. GIT_DIR names another repository: <repo> wins. */
  {
    const A = repo(gpg, 'A');
    const B = repo(gpg, 'B');
    const a0 = refs(A, gpg);
    const b0 = refs(B, gpg);
    const r = H.runBin('git-history-rewrite', ['replace', A, '--rules', rules, '--apply'], opts({ GIT_DIR: path.join(B, '.git') }));
    T.exit('AC-81 [GIT_DIR=B/.git replace A]: exit 0', r, 0);
    T.check('AC-81 [GIT_DIR=B/.git replace A]: A is rewritten', refs(A, gpg) !== a0, '');
    T.eq('AC-81 [GIT_DIR=B/.git replace A]: B is untouched', refs(B, gpg), b0);
    T.eq('AC-81 [GIT_DIR=B/.git replace A]: A\'s main has omega', H.gitRaw(A, gpg, ['show', 'main:a.txt']), 'omega beta\n');
  }

  /* 2. GIT_DIR makes a subdirectory look like a top level: still refused (AC-70). */
  {
    const A = repo(gpg, 'A2');
    const a0 = refs(A, gpg);
    const sub = path.join(A, 'sub');
    const r = H.runBin('git-history-rewrite', ['replace', sub, '--rules', rules, '--apply'], opts({ GIT_DIR: path.join(A, '.git') }));
    T.exit('AC-81 [GIT_DIR=A/.git replace A/sub]: a refusal, exit 1', r, 1);
    T.eq('AC-81 [GIT_DIR=A/.git replace A/sub]: the AC-70 refusal', r.stderr,
      'git-history-rewrite: not the top level of its repository (' + sub + '; the top level is ' + fs.realpathSync(A) + ')\n');
    T.eq('AC-81 [GIT_DIR=A/.git replace A/sub]: A is untouched', refs(A, gpg), a0);
    T.eq('AC-81 [GIT_DIR=A/.git replace A/sub]: no bundle', H.findBackupBundle(sub) || H.findBackupBundle(A), null);
  }

  /* 3. GIT_WORK_TREE: the same refusal, not "working tree is dirty". */
  {
    const A = repo(gpg, 'A3');
    const sub = path.join(A, 'sub');
    const r = H.runBin('git-release-squash', ['tail', sub, '--apply'], opts({ GIT_WORK_TREE: sub }));
    T.exit('AC-81 [GIT_WORK_TREE=A/sub tail A/sub]: a refusal, exit 1', r, 1);
    T.contains('AC-81 [GIT_WORK_TREE=A/sub tail A/sub]: the AC-70 refusal', r.stderr, 'not the top level of its repository');
  }

  /* 4. The caller's git config: GIT_CONFIG_PARAMETERS never reaches git;
   * of the GIT_CONFIG_COUNT family only user.name, user.email and
   * user.signingkey do (any case, as git matches keys), and git-sign's
   * own identity and pins still win over them. */
  {
    const A = repo(gpg, 'A4');
    const bogus = 'A'.repeat(40);
    const r0 = H.runBin('git-history-rewrite', ['replace', A, '--rules', rules, '--apply'],
      opts({ GIT_CONFIG_PARAMETERS: "'user.signingkey'='" + bogus + "'" }));
    T.exit('AC-81 [caller GIT_CONFIG_PARAMETERS user.signingkey=<bogus>, replace --apply]: signs with the repo\'s key, exit 0', r0, 0);

    /* A second key in the same keyring: the owner's, passed the way a release script does. */
    const gen = spawnSync('gpg', ['--batch', '--passphrase', '', '--quick-gen-key', 'Release Owner <owner@example.invalid>', 'ed25519', 'sign', 'never'],
      { env: gpg.env, encoding: 'utf8', timeout: 30000 });
    const fprs = [...(spawnSync('gpg', ['--batch', '--list-secret-keys', '--with-colons'], { env: gpg.env, encoding: 'utf8' }).stdout || '')
      .matchAll(/^fpr:::::::::([0-9A-F]+):/gm)].map((m) => m[1]);
    const owner = fprs.find((f) => f !== gpg.fingerprint) || '';
    T.check('AC-81 fixture: a second (owner) key', gen.status === 0 && owner !== '', gen.stderr);
    const signer = (r: string, rev: string) => {
      const v = H.gitIn(r, gpg)(['verify-commit', '--raw', rev]);
      const m = /VALIDSIG ([0-9A-F]{40})/.exec(String(v.stderr));
      return m ? m[1] : 'none: ' + v.stderr;
    };
    const marker = path.join(outside, 'marker');
    const script = path.join(outside, 'marker.sh');
    fs.writeFileSync(script, '#!/bin/sh\necho "ran $*" >> ' + JSON.stringify(marker) + '\nexec gpg "$@"\n');
    fs.chmodSync(script, 0o755);
    const ran = () => fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8') : '';
    const included = path.join(outside, 'included.gitconfig');
    fs.writeFileSync(included, '[user]\n\tsigningkey = ' + bogus + '\n');
    const count = (pairs: [string, string][]) => Object.assign({ GIT_CONFIG_COUNT: String(pairs.length) },
      ...pairs.map(([k, v], i) => ({ ['GIT_CONFIG_KEY_' + i]: k, ['GIT_CONFIG_VALUE_' + i]: v })));

    const B = repo(gpg, 'B4');
    const r1 = H.runBin('git-history-rewrite', ['replace', B, '--rules', rules, '--apply'],
      opts(count([['gpg.program', script], ['include.path', included], ['core.hooksPath', outside]])));
    T.exit('AC-81 [caller COUNT gpg.program, include.path, core.hooksPath, replace --apply]: exit 0', r1, 0);
    T.eq('AC-81 [caller COUNT gpg.program …]: the marker never ran', ran(), '');
    T.eq('AC-81 [caller COUNT include.path …]: signed with the repo\'s key, not the included one', signer(B, 'main'), gpg.fingerprint);

    const C = repo(gpg, 'C4');
    const r2 = H.runBin('git-history-rewrite', ['replace', C, '--rules', rules, '--apply'], opts(count([['user.signingkey', owner]])));
    T.exit('AC-81 [caller COUNT user.signingkey=<owner>, replace --apply]: exit 0', r2, 0);
    T.eq('AC-81 [caller COUNT user.signingkey=<owner>]: signed with the owner key', signer(C, 'main'), owner);

    const D = repo(gpg, 'D4');
    const r3 = H.runBin('git-history-rewrite', ['replace', D, '--rules', rules, '--apply'],
      opts(count([['User.SigningKey', owner], ['gpg.program', script], ['user.email', 'owner@example.invalid']])));
    T.exit('AC-81 [caller COUNT mixed: User.SigningKey + gpg.program, replace --apply]: exit 0', r3, 0);
    T.eq('AC-81 [caller COUNT mixed]: the identity key is kept', signer(D, 'main'), owner);
    T.eq('AC-81 [caller COUNT mixed]: gpg.program is dropped, the marker never ran', ran(), '');

    const E = repo(gpg, 'E4');
    const r4 = H.runBin('git-release-squash', ['tail', E, '--tag=v2', '--message=release two', '--apply'],
      opts(count([['User.Name', 'Release Owner'], ['user.email', 'owner@example.invalid'], ['user.signingkey', owner]])));
    T.exit('AC-81 [caller COUNT user.name/email/signingkey, tail --tag --apply]: exit 0', r4, 0);
    T.eq('AC-81 [caller COUNT identity, tail]: the commit carries the caller identity',
      H.gitRaw(E, gpg, ['log', '-1', '--format=%an <%ae>|%cn <%ce>', 'main']).trim(), 'Release Owner <owner@example.invalid>|Release Owner <owner@example.invalid>');
    T.eq('AC-81 [caller COUNT identity, tail]: the tagger too', H.gitRaw(E, gpg, ['for-each-ref', '--format=%(taggername) %(taggeremail)', 'refs/tags/v2']).trim(),
      'Release Owner <owner@example.invalid>');
    T.eq('AC-81 [caller COUNT identity, tail]: signed with the owner key', signer(E, 'main'), owner);

    const F = repo(gpg, 'F4');
    fs.writeFileSync(path.join(F, 'c.txt'), 'c\n');
    H.gitIn(F, gpg)(['add', 'c.txt']);
    const policy = H.writePolicy('ac81', { signingKey: gpg.fingerprint });
    const r5 = H.runBin('git-sign', ['commit', F, '--message=third', '--date=auto', '--policy=' + policy, '--apply'],
      opts(Object.assign(count([['user.name', 'Someone Else'], ['user.email', 'else@example.invalid'], ['user.signingkey', owner]]),
        { GHT_NOW: String(Number(H.gitRaw(F, gpg, ['log', '-1', '--format=%ct']).trim()) + 600) })));
    T.exit('AC-81 [caller COUNT identity, git-sign commit --apply]: exit 0', r5, 0);
    T.eq('AC-81 [caller COUNT identity, git-sign commit]: the policy identity wins',
      H.gitRaw(F, gpg, ['log', '-1', '--format=%an <%ae>', 'main']).trim(), 'GHT Test <' + H.FIXTURE_EMAIL + '>');
    T.eq('AC-81 [caller COUNT identity, git-sign commit]: the policy key wins', signer(F, 'main'), gpg.fingerprint);

    for (const [label, env] of [
      ['GIT_CONFIG_PARAMETERS', { GIT_CONFIG_PARAMETERS: "'gpg.program'='" + script + "'" }],
      ['GIT_CONFIG_COUNT', count([['gpg.program', script]])],
    ] as [string, Record<string, string>][]) {
      const r = H.runBin('git-sign', ['check', A, 'HEAD', '--tags', '--policy=' + policy], opts(env));
      T.check('AC-81 [caller ' + label + ' gpg.program, check]: runs (exit 0 or 1)', r.status === 0 || r.status === 1, r.stderr);
      T.eq('AC-81 [caller ' + label + ' gpg.program, check]: the marker never ran', ran(), '');
    }
  }
}

T.finish();
