/* AC-69 -- test hygiene: CANNOT RUN means "the bin is not there", and
 * nothing else. runBin() reports `missing` only for a bin that does not
 * exist; a bin that hangs past its timeout or floods past the output
 * limit is a null status, so the test FAILS rather than reading as an
 * unbuilt tool. run-all counts a file as CANNOT RUN only from the
 * harness's own header line (`FAIL <file> -- CANNOT RUN`), never from the
 * words anywhere in the output, and since every tool exists, any CANNOT
 * RUN makes the run exit 1. A COPY of run-all.ts runs tiny ac files that
 * drive the REAL harness against a fake bin dir: a hanging git-leak-scan,
 * a flooding git-history-rewrite and an absent git-sign. */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as H from '../lib/harness.ts';
const T = H.T;

const RUN_ALL = path.join(H.ROOT, 'test', 'run-all.ts');
const HARNESS = path.join(H.ROOT, 'test', 'lib', 'harness.ts');
const imp = 'import * as H from ' + JSON.stringify(HARNESS) + ';\n';
const FILES: Record<string, string> = {
  'ac-01-ok.ts': imp + "H.T.check('fine', true);\nH.T.finish();\n",
  'ac-02-hang.ts': imp + "H.requireBin('git-leak-scan');\n" +
    "const r = H.runBin('git-leak-scan', ['scan', '/nonexistent'], { timeout: 1500 });\n" +
    "H.T.exit('the scan exits 0', r, 0);\nH.T.finish();\n",
  'ac-03-flood.ts': imp + "H.requireBin('git-history-rewrite');\n" +
    "const r = H.runBin('git-history-rewrite', ['replace', '/nonexistent']);\n" +
    "H.T.exit('the rewrite exits 0', r, 0);\nH.T.finish();\n",
  'ac-04-mention.ts': imp + "console.log('  a passing file whose output says CANNOT RUN in passing');\n" +
    "H.T.check('fine', true);\nH.T.finish();\n",
  'ac-05-absent.ts': imp + "H.requireBin('git-sign');\nH.T.finish();\n",
};
const BINS: Record<string, string> = {
  'git-leak-scan': '#!/bin/sh\nexec sleep 600\n',
  /* Past runBin's 32 MiB maxBuffer. */
  'git-history-rewrite': '#!/bin/sh\nexec head -c 40000000 /dev/zero\n',
};

/* A red run can leave the hanging fake bin behind: kill whatever still
 * runs from this case. Linux only (/proc), as in AC-68. */
function killLeftovers(base: string) {
  let pids: string[] = [];
  try { pids = fs.readdirSync('/proc').filter((n) => /^\d+$/.test(n)); } catch (e) { return; }
  for (const p of pids) {
    let cmd = '';
    try { cmd = fs.readFileSync('/proc/' + p + '/cmdline', 'utf8'); } catch (e) { continue; }
    if (cmd.includes(base + '/') && Number(p) !== process.pid) { try { process.kill(Number(p), 'SIGKILL'); } catch (e) { /* gone */ } }
  }
}

function runCase(label: string, names: string[]) {
  const base = H.freshDir('ac69-' + label);
  fs.mkdirSync(path.join(base, 'test', 'ac'), { recursive: true });
  fs.writeFileSync(path.join(base, 'test', 'run-all.ts'), fs.readFileSync(RUN_ALL, 'utf8'));
  for (const f of names) fs.writeFileSync(path.join(base, 'test', 'ac', f), FILES[f]);
  const bin = path.join(base, 'bin');
  fs.mkdirSync(bin);
  for (const [b, body] of Object.entries(BINS)) {
    fs.writeFileSync(path.join(bin, b), body);
    fs.chmodSync(path.join(bin, b), 0o755);
  }
  const root = path.join(base, 'root');
  fs.mkdirSync(root);
  const env: NodeJS.ProcessEnv = Object.assign({}, process.env, { GHT_TEST_ROOT: root, TMPDIR: root });
  delete env.GHT_KEEP; delete env.GHT_TEST_TIMES; delete env.GHT_TEST_JOBS; delete env.GHT_BIN_DIR;
  const r = spawnSync(process.execPath, [path.join(base, 'test', 'run-all.ts'), '--jobs=2', bin],
    { cwd: base, env, encoding: 'utf8', timeout: 60000, killSignal: 'SIGKILL' });
  killLeftovers(base);
  const out = (r.stdout || '') + (r.stderr || '');
  return { status: r.status, out, tail: ('exit ' + r.status + '\n' + out).split('\n').slice(-24).join('\n') };
}

{
  const c = runCase('mixed', Object.keys(FILES));
  T.check('AC-69: a passing file passes', /^PASS ac-01-ok\.ts$/m.test(c.out), c.tail);
  T.check('AC-69: a bin that hangs past its timeout is a FAIL, not CANNOT RUN', /^FAIL ac-02-hang\.ts$/m.test(c.out), c.tail);
  T.check('AC-69: a bin that floods past the output limit is a FAIL, not CANNOT RUN', /^FAIL ac-03-flood\.ts$/m.test(c.out), c.tail);
  T.check('AC-69: "CANNOT RUN" in a passing file\'s own output does not make it CANNOT RUN', /^PASS ac-04-mention\.ts$/m.test(c.out), c.tail);
  T.check('AC-69: an absent bin is CANNOT RUN', /^CANNOT RUN ac-05-absent\.ts$/m.test(c.out), c.tail);
  T.check('AC-69: the summary counts 2 passed, 2 failed, 1 cannot run', /^2 passed, 2 failed, 1 cannot run, 5 total$/m.test(c.out), c.tail);
  T.eq('AC-69: run-all exits 1', c.status, 1);
}
{
  const c = runCase('cannot-run-only', ['ac-01-ok.ts', 'ac-05-absent.ts']);
  T.check('AC-69 [no failure, one CANNOT RUN]: the summary counts it', /^1 passed, 0 failed, 1 cannot run, 2 total$/m.test(c.out), c.tail);
  T.eq('AC-69 [no failure, one CANNOT RUN]: run-all still exits 1', c.status, 1);
}
{
  const c = runCase('all-pass', ['ac-01-ok.ts', 'ac-04-mention.ts']);
  T.check('AC-69 [all pass]: the summary counts 2 passed', /^2 passed, 0 failed, 0 cannot run, 2 total$/m.test(c.out), c.tail);
  T.eq('AC-69 [all pass]: run-all exits 0', c.status, 0);
}

T.finish();
