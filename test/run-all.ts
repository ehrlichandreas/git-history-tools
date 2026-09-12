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

let passed = 0, failed = 0, cannotRun = 0;
const failures: string[] = [];

for (const f of files) {
  const env = Object.assign({}, process.env, { TMPDIR: process.env.TMPDIR || '/tmp' });
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

process.exit(failed > 0 ? 1 : 0);
