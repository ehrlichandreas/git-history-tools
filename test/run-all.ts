/*
 * Runs every test/ac/ac-*.ts file as a child process and summarises the
 * result. Usage: node test/run-all.ts [--jobs=<n>] [bin-dir]
 * GHT_BIN_DIR (or the bin-dir argument) selects which bin/ to drive;
 * default is the repo's own bin/ next to this test tree.
 *
 * Files run concurrently, `--jobs=<n>` (or GHT_TEST_JOBS) at a time,
 * default min(os.availableParallelism(), 8), as nanojira's run-all does.
 * Each file's report is buffered and printed as one block, in file order,
 * as soon as every earlier file has finished -- never interleaved, so the
 * output of a pooled run reads like a serial one. A file whose header
 * carries a `@serial` marker (see hasMark()) is held back and run alone
 * after the pool has drained; a file marked `@slow` is started first, so
 * the longest files do not begin late and stretch the pool (dispatch
 * order only, never print order). `--jobs=1` is the old strictly serial
 * loop: file order, markers irrelevant, the same output.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const AC_DIR = path.join(import.meta.dirname, 'ac');

const JOBS_FLAG = /^--jobs=(.*)$/;
const jobsArg = process.argv.slice(2).map((a) => JOBS_FLAG.exec(a)).find(Boolean);
const positional = process.argv.slice(2).filter((a) => !JOBS_FLAG.test(a));
const binDir = positional[0] || process.env.GHT_BIN_DIR;

function parseJobs(): number {
  const raw = jobsArg ? jobsArg[1] : process.env.GHT_TEST_JOBS;
  if (raw === undefined || raw === '') return Math.max(1, Math.min(os.availableParallelism(), 8));
  if (!/^[1-9][0-9]*$/.test(raw)) {
    console.log('run-all: ' + (jobsArg ? '--jobs' : 'GHT_TEST_JOBS') + ' must be a positive integer, got ' + JSON.stringify(raw));
    process.exit(2);
  }
  return Number(raw);
}
const JOBS = parseJobs();

const files = fs.readdirSync(AC_DIR).filter(f => /^ac-\d+-.*\.ts$/.test(f)).sort();

/* A marker (`@serial`, `@slow`) must open a comment line of the file's
 * header -- `/* @serial: ...` or ` * @slow: ...` -- before its first
 * `import`, so prose mentioning it further down never trips it. The rest
 * of the line is the reason. */
function hasMark(f: string, mark: string): boolean {
  const head = fs.readFileSync(path.join(AC_DIR, f), 'utf8').split(/^import\b/m)[0];
  return new RegExp('^\\s*(?:/\\*+|\\*)\\s*@' + mark + '\\b', 'm').test(head);
}

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
const testRoot = fs.realpathSync(process.env.GHT_TEST_ROOT || '/tmp');
const runRoot = fs.mkdtempSync(path.join(testRoot, 'ght-run-all-'));

/* Node's compile cache for every node process of the run -- each test
 * file, and every bin/* call, which is `node lib/<tool>.ts` and would
 * otherwise type-strip and compile the whole lib/ graph again each time.
 * Next to the run root, not in it (it is no leak) and not in os.tmpdir()
 * (may be on disk); removed at the end, GHT_KEEP or not. */
const cacheDir = fs.mkdtempSync(path.join(testRoot, 'ght-node-cache-'));

const env = Object.assign({}, process.env, { TMPDIR: runRoot, GHT_TEST_ROOT: runRoot, NODE_COMPILE_CACHE: cacheDir });
if (binDir) env.GHT_BIN_DIR = binDir;

const TIMEOUT_MS = 120000;
/* A file still running TIMEOUT_MS after it started is a FAIL, whatever it
 * exits with later (AC-68): the pool sends SIGTERM, then SIGKILL after
 * KILL_GRACE_MS; the serial path (spawnSync, which cannot escalate) kills
 * with SIGKILL at once. The harness installs no signal handler, so for a
 * harness file both end it at once anyway. */
const KILL_GRACE_MS = 10000;
const timedOutNote = (how: string) => 'run-all: timed out after ' + (TIMEOUT_MS / 1000) + ' s; killed (' + how + ')';
const MAX_BUFFER = 1024 * 1024;   // spawnSync's default, which the serial loop has always used

interface Result { status: number | null; out: string; timedOut?: string }

function runSync(f: string): Result {
  const r = spawnSync(process.execPath, [path.join(AC_DIR, f)], { encoding: 'utf8', env, timeout: TIMEOUT_MS, killSignal: 'SIGKILL' });
  const out = (r.stdout || '') + (r.stderr || '');
  if ((r.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT') return { status: null, out, timedOut: timedOutNote('SIGKILL') };
  return { status: r.status, out };
}

/* The async twin of runSync(), kept to spawnSync's observable contract so a
 * file's verdict cannot depend on which phase ran it: stdin closed at once,
 * stdout then stderr (not interleaved), a null status once either stream
 * passes MAX_BUFFER, and a spawn error is an empty-output null status. On
 * the timeout both give a null status and a timed-out note; runSync kills
 * with SIGKILL, this one with SIGTERM, then SIGKILL after KILL_GRACE_MS.
 * Parked (as in nanojira): it resolves on 'close', so a grandchild that
 * inherited the file's stdout/stderr would keep the pipes open, and the run
 * waiting, even after the file itself is killed. No test spawns one today;
 * a process-group kill would cover it. */
function runAsync(f: string): Promise<Result> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(AC_DIR, f)], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = [], err: Buffer[] = [];
    let outLen = 0, errLen = 0, done = false, timedOut = false;
    let grace: NodeJS.Timeout | undefined;
    const kill = (sig: NodeJS.Signals = 'SIGTERM') => { try { child.kill(sig); } catch { /* already gone */ } };
    const timer = setTimeout(() => {
      timedOut = true;
      kill('SIGTERM');
      grace = setTimeout(() => kill('SIGKILL'), KILL_GRACE_MS);
    }, TIMEOUT_MS);
    child.stdin.on('error', () => { /* child exited before reading stdin */ });
    child.stdin.end();
    child.stdout.on('data', (b: Buffer) => { outLen += b.length; if (outLen > MAX_BUFFER) kill(); else out.push(b); });
    child.stderr.on('data', (b: Buffer) => { errLen += b.length; if (errLen > MAX_BUFFER) kill(); else err.push(b); });
    const finish = (status: number | null, text: string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (grace) clearTimeout(grace);
      resolve(timedOut ? { status: null, out: text, timedOut: timedOutNote('SIGTERM, then SIGKILL after ' + (KILL_GRACE_MS / 1000) + ' s') } : { status, out: text });
    };
    child.on('error', () => finish(null, ''));
    child.on('close', (code, signal) => {
      const overflow = outLen > MAX_BUFFER || errLen > MAX_BUFFER;
      finish(signal || overflow ? null : code, Buffer.concat(out).toString('utf8') + Buffer.concat(err).toString('utf8'));
    });
  });
}

let passed = 0, failed = 0, cannotRun = 0;
const failures: string[] = [];

/* CANNOT RUN only from the harness's own header line (abortNoImplementation:
 * `FAIL <file> -- CANNOT RUN`), never from the words anywhere in the output,
 * and never for a file that timed out (AC-69). */
const CANNOT_RUN_HEADER = /^FAIL \S+ -- CANNOT RUN$/;

function report(f: string, r: Result): void {
  const out = r.out;
  if (!r.timedOut && CANNOT_RUN_HEADER.test(out.split('\n')[0])) {
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
  if (r.timedOut) console.log('  ' + r.timedOut);
}

/* GHT_TEST_TIMES=<file>: write each file's wall time there (TSV, slowest
 * first, with the phase it ran in and its start offset, then a `total`
 * row). Nothing on stdout changes. Same format as nanojira's
 * NJ_TEST_TIMES. */
const T0 = Date.now();
const times: { f: string; phase: string; start: number; ms: number }[] = [];
async function timed(f: string, phase: string, run: () => Result | Promise<Result>): Promise<Result> {
  const start = Date.now();
  const r = await run();
  times.push({ f, phase, start: start - T0, ms: Date.now() - start });
  return r;
}

/* `indices` is the print order (file order); `order` the dispatch order, a
 * permutation of positions into `indices`. */
async function runPool(indices: number[], order: number[]): Promise<void> {
  const results: (Result | undefined)[] = new Array(indices.length);
  let next = 0, printed = 0;
  const flush = () => {
    while (printed < indices.length && results[printed]) {
      report(files[indices[printed]], results[printed] as Result);
      results[printed] = { status: null, out: '' };   // release the buffer
      printed++;
    }
  };
  const worker = async () => {
    while (next < order.length) {
      const k = order[next++];
      results[k] = await timed(files[indices[k]], 'pool', () => runAsync(files[indices[k]]));
      flush();
    }
  };
  await Promise.all(Array.from({ length: Math.min(JOBS, indices.length) }, worker));
}

const all = files.map((_, i) => i);
if (JOBS === 1) {
  for (const i of all) report(files[i], await timed(files[i], 'serial', () => runSync(files[i])));
} else {
  const serial = all.filter((i) => hasMark(files[i], 'serial'));
  const pooled = all.filter((i) => !serial.includes(i));
  const slow = pooled.map((_, k) => k).filter((k) => hasMark(files[pooled[k]], 'slow'));
  await runPool(pooled, slow.concat(pooled.map((_, k) => k).filter((k) => !slow.includes(k))));
  for (const i of serial) report(files[i], await timed(files[i], 'serial', () => runSync(files[i])));
}

if (process.env.GHT_TEST_TIMES) {
  fs.writeFileSync(process.env.GHT_TEST_TIMES, 'file\tphase\tstart_ms\tms\n' + times.sort((a, b) => b.ms - a.ms)
    .map((x) => [x.f, x.phase, x.start, x.ms].join('\t')).join('\n') + '\n' + 'total\t-\t0\t' + (Date.now() - T0) + '\n');
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed, ' + cannotRun + ' cannot run, ' + files.length + ' total');
if (failures.length) console.log('failed: ' + failures.join(', '));

fs.rmSync(cacheDir, { recursive: true, force: true });
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

/* Every tool exists, so a CANNOT RUN can only mean a bin that went missing
 * (a wrong bin dir, a broken install): it fails the run too (AC-69, D19). */
process.exit(failed > 0 || cannotRun > 0 || (leftover.length > 0 && !keep) ? 1 : 0);
