/* AC-68 -- test hygiene: a test file still running at run-all's per-file
 * timeout is a FAIL whatever it exits with later, and is gone soon after:
 * the pool sends SIGTERM, then SIGKILL after a grace period; the serial
 * path kills with SIGKILL (spawnSync cannot escalate). A COPY of
 * run-all.ts, with its timeout and grace shortened in the copy, runs three
 * tiny ac files: one passing, one that defers SIGTERM through synchronous
 * work and then exits 0 inside the grace (only the timed-out flag can fail
 * it), one that ignores SIGTERM forever (only SIGKILL ends it). */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as H from '../lib/harness.ts';
const T = H.T;

const RUN_ALL = path.join(H.ROOT, 'test', 'run-all.ts');
const FILES: Record<string, string> = {
  'ac-01-ok.ts': "console.log('ok');\n",
  'ac-02-defer.ts': "import { spawnSync } from 'node:child_process';\n" +
    "process.on('SIGTERM', () => {});\nspawnSync('sleep', ['2']);\nconsole.log('done');\n",
  'ac-03-ignore.ts': "process.on('SIGTERM', () => {});\nsetInterval(() => {}, 1000);\n",
};
const src = fs.readFileSync(RUN_ALL, 'utf8');
T.check('AC-68: run-all has a per-file timeout constant', /^const TIMEOUT_MS = \d+;$/m.test(src), '');
T.check('AC-68: run-all has a kill grace constant', /^const KILL_GRACE_MS = \d+;$/m.test(src), '');
const patched = src.replace(/^const TIMEOUT_MS = \d+;$/m, 'const TIMEOUT_MS = 1500;')
  .replace(/^const KILL_GRACE_MS = \d+;$/m, 'const KILL_GRACE_MS = 1000;');

/* On a red run the guard kills run-all, which would leave ac-03 running
 * forever: kill whatever still runs from this case. Linux only (/proc);
 * elsewhere a red run can leave ac-03 behind (parked, as in nanojira). */
function killLeftovers(base: string) {
  let pids: string[] = [];
  try { pids = fs.readdirSync('/proc').filter((n) => /^\d+$/.test(n)); } catch (e) { return; }
  for (const p of pids) {
    let cmd = '';
    try { cmd = fs.readFileSync('/proc/' + p + '/cmdline', 'utf8'); } catch (e) { continue; }
    if (cmd.includes(base + '/test/') && Number(p) !== process.pid) { try { process.kill(Number(p), 'SIGKILL'); } catch (e) { /* gone */ } }
  }
}

function runCase(label: string, args: string[]) {
  const base = H.freshDir('ac68-' + label);
  fs.mkdirSync(path.join(base, 'test', 'ac'), { recursive: true });
  fs.writeFileSync(path.join(base, 'test', 'run-all.ts'), patched);
  for (const [f, body] of Object.entries(FILES)) fs.writeFileSync(path.join(base, 'test', 'ac', f), body);
  const root = path.join(base, 'root');
  fs.mkdirSync(root);
  const env: NodeJS.ProcessEnv = Object.assign({}, process.env, { GHT_TEST_ROOT: root, TMPDIR: root });
  delete env.GHT_KEEP; delete env.GHT_TEST_TIMES; delete env.GHT_TEST_JOBS;
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [path.join(base, 'test', 'run-all.ts'), ...args],
    { cwd: base, env, encoding: 'utf8', timeout: 40000, killSignal: 'SIGKILL' });
  killLeftovers(base);
  return { status: r.status, out: (r.stdout || '') + (r.stderr || ''), ms: Date.now() - t0 };
}

for (const [label, args] of [['pooled', ['--jobs=2']], ['serial', ['--jobs=1']]] as [string, string[]][]) {
  const c = runCase(label, args);
  const tail = ('exit ' + c.status + ', ' + c.ms + ' ms\n' + c.out).split('\n').slice(-14).join('\n');
  T.eq('AC-68 [' + label + ']: run-all exits 1', c.status, 1);
  T.check('AC-68 [' + label + ']: the passing file passes', /^PASS ac-01-ok\.ts$/m.test(c.out), tail);
  T.check('AC-68 [' + label + ']: the file that deferred SIGTERM and exited 0 is a FAIL', /^FAIL ac-02-defer\.ts$/m.test(c.out), tail);
  T.check('AC-68 [' + label + ']: the file that ignores SIGTERM is a FAIL', /^FAIL ac-03-ignore\.ts$/m.test(c.out), tail);
  T.check('AC-68 [' + label + ']: both name the timeout', (c.out.match(/timed out after 1\.5 s/g) || []).length === 2, tail);
  T.check('AC-68 [' + label + ']: the summary counts 1 passed, 2 failed', /^1 passed, 2 failed/m.test(c.out), tail);
  T.check('AC-68 [' + label + ']: and the run ends soon, not after the sleep or never', c.ms < 15000, tail);
}

T.finish();
