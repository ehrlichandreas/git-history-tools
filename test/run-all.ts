/*
 * Runs every test/ac/ac-*.ts file as a child process and summarises the
 * result. Usage: node test/run-all.ts [bin-dir]
 * GHT_BIN_DIR (or argv[2]) selects which bin/ to drive; default is the
 * repo's own bin/ next to this test tree.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const AC_DIR = path.join(import.meta.dirname, 'ac');
const binDir = process.argv[2] || process.env.GHT_BIN_DIR;

const files = fs.readdirSync(AC_DIR).filter(f => /^ac-\d+-.*\.ts$/.test(f)).sort();

/* One root for the whole run, passed to every child as BOTH GHT_TEST_ROOT
 * and TMPDIR: every fixture dir lands inside it, whether it goes through
 * the harness's tracked `freshDir()` or (ac-49's bug, 546 leaked dirs on
 * the SSD) a raw `os.tmpdir()` call, which reads TMPDIR. It is made where
 * the harness puts fixtures anyway (GHT_TEST_ROOT, else /tmp), never in
 * the parent's TMPDIR, which may be on disk. Whatever is still in it after
 * the last file is a leak -- no name heuristic, and another process's
 * directory elsewhere in /tmp can neither cause nor hide a failure (a
 * /tmp before/after delta did raise such false alarms). Not caught: a
 * leak into a hardcoded path such as '/tmp/...', which bypasses both
 * variables. Under GHT_KEEP=1 the harness keeps its fixtures on purpose:
 * the root then stays, its path is printed, and its content is no
 * failure. */
const runRoot = fs.mkdtempSync(path.join(fs.realpathSync(process.env.GHT_TEST_ROOT || '/tmp'), 'ght-run-all-'));

let passed = 0, failed = 0, cannotRun = 0;
const failures: string[] = [];

for (const f of files) {
  const env = Object.assign({}, process.env, { TMPDIR: runRoot, GHT_TEST_ROOT: runRoot });
  if (binDir) env.GHT_BIN_DIR = binDir;
  const r = spawnSync(process.execPath, [path.join(AC_DIR, f)], { encoding: 'utf8', env, timeout: 120000 });
  const out = (r.stdout || '') + (r.stderr || '');
  if (/CANNOT RUN/.test(out)) {
    cannotRun++;
    console.log('CANNOT RUN ' + f);
  } else if (r.status === 0) {
    passed++;
    console.log('PASS ' + f);
  } else {
    failed++;
    failures.push(f);
    console.log('FAIL ' + f);
  }
  const lines = out.trim().split('\n');
  for (const l of lines) if (l.startsWith('  ')) console.log(l);
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed, ' + cannotRun + ' cannot run, ' + files.length + ' total');
if (failures.length) console.log('failed: ' + failures.join(', '));

const leftover = fs.readdirSync(runRoot).sort();
const keep = process.env.GHT_KEEP === '1' && leftover.length > 0;
if (leftover.length) {
  const what = leftover.length + ' entr' + (leftover.length === 1 ? 'y' : 'ies');
  console.log('');
  console.log(keep ? 'kept (GHT_KEEP=1, not a failure) ' + what + ' in ' + runRoot + ':'
    : 'leaked ' + what + ' this run left in its run root (now removed):');
  for (const n of leftover.slice(0, 10)) console.log('  ' + n);
  if (leftover.length > 10) console.log('  ... and ' + (leftover.length - 10) + ' more');
}
if (!keep) fs.rmSync(runRoot, { recursive: true, force: true });

process.exit(failed > 0 || (leftover.length > 0 && !keep) ? 1 : 0);
