/* AC-67 -- test hygiene: a test that dies before T.finish() still removes
 * the fixture dirs it made, and the harness never defers a kill. An
 * uncaught exception, an unhandled rejection or a bare process.exit() fire
 * node's 'exit', where the harness cleans up. There is no signal handler:
 * a JS signal listener only runs once the event loop is free, so it would
 * hold run-all's timeout SIGTERM through any synchronous work and let the
 * test reach T.finish() -- so a SIGTERM must end the test at once, BY the
 * signal, even mid-spawnSync (what it made then stays; under run-all that
 * is inside the run root, which the leak sweep removes). Each case runs a
 * tiny child script that makes one freshDir under a private tmp root.
 * GHT_KEEP=1 keeps the dir. */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import * as H from '../lib/harness.ts';
const T = H.T;

const HARNESS = path.join(H.ROOT, 'test', 'lib', 'harness.ts');
const scripts = H.freshDir('ac67-scripts');
const child = path.join(scripts, 'child.ts');
fs.writeFileSync(child, [
  "import fs from 'node:fs';",
  "import { spawnSync } from 'node:child_process';",
  'import * as H from ' + JSON.stringify(HARNESS) + ';',
  "const d = H.freshDir('ac67-crash');",
  "fs.writeFileSync(d + '/marker', 'x');",
  "process.stdout.write('READY ' + d + '\\n');",
  'const mode = process.argv[2];',
  "if (mode === 'throw') throw new Error('ac67 boom');",
  "if (mode === 'reject') Promise.reject(new Error('ac67 rejected'));",
  "if (mode === 'exit') process.exit(3);",
  "if (mode === 'sleep') spawnSync('sleep', ['5']);",
  "if (mode === 'busy') { const t = Date.now(); while (Date.now() - t < 5000) { /* sync work */ } }",
  "if (mode === 'sleep' || mode === 'busy') { H.T.check('ran to the end', true); H.T.finish(); }",
  '',
].join('\n'));

function freshRoot(label: string): string { return fs.mkdtempSync(path.join(H.TMP_ROOT, 'ght-ac67-' + label + '-')); }
function childEnv(root: string, keep?: boolean): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = Object.assign({}, process.env, { GHT_TEST_ROOT: root, TMPDIR: root });
  if (keep) env.GHT_KEEP = '1'; else delete env.GHT_KEEP;
  return env;
}
const left = (root: string) => fs.readdirSync(root);

for (const [mode, expectStatus] of [['throw', 1], ['reject', 1], ['exit', 3]] as [string, number][]) {
  const root = freshRoot(mode);
  try {
    const r = spawnSync(process.execPath, [child, mode], { env: childEnv(root), encoding: 'utf8', timeout: 30000 });
    T.check('AC-67 [' + mode + ']: the child made its freshDir', /^READY /m.test(r.stdout || ''), (r.stdout || '') + (r.stderr || ''));
    T.eq('AC-67 [' + mode + ']: exit status', r.status, expectStatus);
    T.eq('AC-67 [' + mode + ']: nothing is left in the tmp root', left(root), []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

for (const mode of ['sleep', 'busy']) {
  const tag = 'AC-67 [SIGTERM during ' + (mode === 'sleep' ? 'spawnSync' : 'a sync loop') + ']';
  const root = freshRoot(mode);
  try {
    const res = await new Promise<{ signal: string | null; out: string; afterKillMs: number }>((resolve) => {
      const c = spawn(process.execPath, [child, mode], { env: childEnv(root), stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '', killedAt = 0;
      const guard = setTimeout(() => c.kill('SIGKILL'), 30000);
      c.stdout.on('data', (b) => {
        out += b;
        if (!killedAt && /^READY /m.test(out)) setTimeout(() => { killedAt = Date.now(); c.kill('SIGTERM'); }, 300);
      });
      c.on('close', (_code, signal) => { clearTimeout(guard); resolve({ signal, out, afterKillMs: Date.now() - killedAt }); });
    });
    T.check(tag + ': the child made its freshDir', /^READY /m.test(res.out), res.out);
    T.eq(tag + ': the child dies BY the signal', res.signal, 'SIGTERM');
    T.check(tag + ': within ~1 s of the signal, not after the sync work', res.afterKillMs < 1500, res.afterKillMs + ' ms; ' + res.out);
    T.check(tag + ': it never reached T.finish()', !/^PASS /m.test(res.out), res.out);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

{
  const root = freshRoot('keep');
  try {
    spawnSync(process.execPath, [child, 'throw'], { env: childEnv(root, true), encoding: 'utf8', timeout: 30000 });
    // The harness's own dirs (its XDG_CONFIG_HOME, AC-66) are kept too under GHT_KEEP=1.
    const kept = left(root).filter((n) => n.startsWith('ght-ac67-crash-'));
    T.check('AC-67 [GHT_KEEP=1, throw]: the freshDir is kept, with its content',
      kept.length === 1 && fs.existsSync(path.join(root, kept[0], 'marker')), JSON.stringify(left(root)));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

T.finish();
