'use strict';
/* AC-40 -- test hygiene (D2, commit a4e8b9f; GHT-7): the harness's own
 * cleanup removes every kind of entry a test's fixtures could leave
 * behind under the tmp root, not just the fixture repo dirs themselves --
 * a backup bundle sits NEXT TO its repo (§ 4.1) as a sibling file, and
 * scratch files (map/rules/message files, now all routed through
 * H.freshDir() rather than hardcoded /tmp paths) are their own mkdtemp'd
 * directories alongside it. Plain `fs.rmSync` on a repo dir touches
 * neither. This runs a handful of representative AC files -- covering
 * bundle creation (apply/tail/rewrite) and heavy scratch-file use
 * (tail --tag, dry-run rewrite) -- against a FRESH, otherwise-empty tmp
 * root and asserts the root holds exactly zero entries of ANY kind
 * afterward. */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const H = require('../lib/harness.js');
const T = H.T;

const AC_DIR = path.join(__dirname);
/* Chosen because each one creates at least one backup bundle (an
 * --apply write) in addition to its own ordinary fixture dirs: squash
 * apply/tail, rewrite replace/add-file, and AC-35/37's multi-repo,
 * multi-release runs. */
const REPRESENTATIVE = [
  'ac-09-squash-apply-creates-backup-bundle.js',
  'ac-15-squash-tail-basic.js',
  'ac-32-rewrite-apply-creates-backup-bundle.js',
  'ac-35-squash-tail-continues-dates.js',
  'ac-36-squash-tail-tag-release.js',
  'ac-39-rewrite-dry-run-writes-no-objects.js',
];

const freshRoot = fs.mkdtempSync(path.join(H.TMP_ROOT, 'ght-ac40-fresh-'));
try {
  for (const f of REPRESENTATIVE) {
    const p = path.join(AC_DIR, f);
    T.check('AC-40 fixture: ' + f + ' exists', fs.existsSync(p), p);
    if (!fs.existsSync(p)) continue;
    const r = spawnSync(process.execPath, [p], {
      encoding: 'utf8',
      timeout: 60000,
      env: Object.assign({}, process.env, { GHT_TEST_ROOT: freshRoot }),
    });
    const out = (r.stdout || '') + (r.stderr || '');
    T.check('AC-40: ' + f + ' ran to completion under the fresh root (not a crash)',
      r.status === 0 || /CANNOT RUN/.test(out), out.slice(0, 400));
  }

  const left = fs.readdirSync(freshRoot);
  T.eq('AC-40: the fresh tmp root holds exactly 0 entries of any kind after all of the above (fixture dirs, backup bundles, and scratch-file directories are all gone)',
    left, []);
} finally {
  try { fs.rmSync(freshRoot, { recursive: true, force: true }); } catch (e) { /* best effort */ }
}

T.finish();
