/* AC-41 -- D7: resolving bin/*'s symlink (D6) is not enough on its own once
 * this package is installed as a real npm dependency -- Node refuses to
 * type-strip any .ts file whose resolved path contains the literal string
 * "node_modules" (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING), no matter
 * how correctly the symlink resolves. A symlink test outside node_modules
 * (D6's own coverage) has the same blind spot that let this ship once
 * already -- it never exercises that restriction at all.
 *
 * This test builds an actual node_modules-shaped fixture: a fake package
 * directory whose path literally contains "node_modules", holding a copy
 * of this repo's own dist/*.mjs, plus a real .bin-style symlink into it --
 * the same shape `npm install` itself creates -- and runs each tool
 * through that symlink, not through bin/* or lib/*.ts directly. */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as H from '../lib/harness.ts';
const T = H.T;

const DIST_DIR = path.join(H.ROOT, 'dist');
const ENTRIES: Array<{ bin: string; mjs: string }> = [
  { bin: 'git-release-squash', mjs: 'squash.mjs' },
  { bin: 'git-leak-scan', mjs: 'scan.mjs' },
  { bin: 'git-history-rewrite', mjs: 'rewrite.mjs' },
];

for (const { mjs } of ENTRIES) {
  const p = path.join(DIST_DIR, mjs);
  if (!fs.existsSync(p)) H.abortNoImplementation('dist/' + mjs + ' not found at ' + p + ' -- run `npm run build` first');
}

const fixtureRoot = H.freshDir('ac41');
const fakePkgDir = path.join(fixtureRoot, 'node_modules', 'git-history-tools');
const fakeBinDir = path.join(fixtureRoot, 'node_modules', '.bin');
fs.mkdirSync(fakeBinDir, { recursive: true });
fs.cpSync(DIST_DIR, path.join(fakePkgDir, 'dist'), { recursive: true });

const symlinkFor: Record<string, string> = {};
for (const { bin, mjs } of ENTRIES) {
  const link = path.join(fakeBinDir, bin);
  fs.symlinkSync(path.join('..', 'git-history-tools', 'dist', mjs), link);
  symlinkFor[bin] = link;
}

T.check('AC-41 fixture: node_modules/.bin/git-release-squash is a symlink (same shape npm install creates)',
  fs.lstatSync(symlinkFor['git-release-squash']).isSymbolicLink());

/* git-release-squash: a full, real `plan` run through the symlink -- exit 0
 * and genuine plan output, not merely "didn't crash". */
const gpg = H.setupGpg('ac41');
if (gpg) {
  const repo = H.initRepo('ac41', gpg);
  H.commit(repo, gpg, 'root', { 'a.txt': 'one\n' });
  H.tagSigned(repo, gpg, 'v1', 'release v1');

  const r = spawnSync(symlinkFor['git-release-squash'], ['plan', repo], {
    encoding: 'utf8',
    timeout: 30000,
    env: Object.assign({}, process.env, { GNUPGHOME: gpg.gnupgHome }),
  });
  T.check('AC-41 git-release-squash: no spawn error', !r.error, r.error && String(r.error.message));
  T.check('AC-41 git-release-squash: does not hit ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING',
    !/ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING/.test(r.stderr || ''), r.stderr);
  T.check('AC-41 git-release-squash: does not hit a module-resolution error (the D6 symlink bug)',
    !/Cannot find module/.test(r.stderr || ''), r.stderr);
  T.eq('AC-41 git-release-squash: plan exits 0 through the node_modules/.bin symlink', r.status, 0);
  T.contains('AC-41 git-release-squash: plan output names the v1 tag', r.stdout, 'v1');
}

/* git-leak-scan and git-history-rewrite: no args is a usage error (exit 2)
 * in the direct-checkout form (confirmed above against lib/*.ts) -- the
 * same exit code through the symlink proves the CLI itself ran, as
 * opposed to crashing during module resolution/type-stripping. */
for (const bin of ['git-leak-scan', 'git-history-rewrite']) {
  const r = spawnSync(symlinkFor[bin], [], { encoding: 'utf8', timeout: 30000 });
  T.check('AC-41 ' + bin + ': no spawn error', !r.error, r.error && String(r.error.message));
  T.check('AC-41 ' + bin + ': does not hit ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING',
    !/ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING/.test(r.stderr || ''), r.stderr);
  T.check('AC-41 ' + bin + ': does not hit a module-resolution error (the D6 symlink bug)',
    !/Cannot find module/.test(r.stderr || ''), r.stderr);
  T.eq('AC-41 ' + bin + ': reaches its own usage-error path (exit 2) through the node_modules/.bin symlink', r.status, 2);
}

T.finish();
