/*
 * git-history-tools verification harness -- zero dependencies, Node
 * built-ins only.
 *
 * Contract for every test file in this tree:
 *
 *   import * as H from '../lib/harness.ts';
 *   H.requireBin('release-squash');
 *   const r = H.runBin('release-squash', ['plan', repo], {});
 *   H.T.eq('description', actual, expected);
 *   H.T.finish();
 *
 * Tests drive the bin/ wrappers as a black box: they never import the
 * lib/*.ts files, never read their source, and assert only on observable
 * behaviour -- exit code, stdout, stderr and the bytes/refs the tool leaves
 * behind in a fixture repo.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

export const ROOT = path.resolve(import.meta.dirname, '..', '..');
export const BIN_DIR = process.env.GHT_BIN_DIR ? path.resolve(process.env.GHT_BIN_DIR) : path.join(ROOT, 'bin');

/* Fixture root -- deliberately /tmp, realpath'd (macOS's /tmp is itself a
 * symlink to /private/tmp, and a fixture path containing the un-resolved
 * form can disagree byte-for-byte with a path the tool under test resolves
 * and reports back on its own). NJ_TEST_ROOT-style override: GHT_TEST_ROOT. */
export const TMP_ROOT = fs.realpathSync(process.env.GHT_TEST_ROOT || '/tmp');

const _tmpDirs: string[] = [];
const _gnupgHomes: string[] = [];

/** A fresh empty directory under /tmp. */
export function freshDir(label?: string): string {
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, 'ght-' + (label || 't') + '-'));
  _tmpDirs.push(dir);
  return dir;
}

export function binPath(name: string): string { return path.join(BIN_DIR, name); }

/**
 * A GNUPGHOME path under /tmp that is guaranteed not to exist. Used as the
 * default for runBin() when a caller passes no gnupgHome of its own -- a
 * test that forgets to wire up its throwaway key must still fail loudly
 * (gpg finds no keyring there) rather than silently falling back to the
 * real ~/.gnupg, even for a read. Queued for cleanup in case gpg ever
 * creates it lazily (e.g. an empty keyring on first touch).
 */
function noGnupgHome(): string {
  const p = path.join(TMP_ROOT, 'ght-no-gnupg-' + crypto.randomBytes(6).toString('hex'));
  _tmpDirs.push(p);
  return p;
}

/**
 * The bin/* tools are written after this spec+test tree, so "the binary is
 * absent" is the expected state right now -- abort loudly and cleanly
 * instead of a confusing spawn ENOENT deep in some later assertion.
 */
export function abortNoImplementation(missing: string): never {
  const name = path.basename(process.argv[1] || 'test');
  console.log('FAIL ' + name + ' -- CANNOT RUN');
  console.log('  ' + missing);
  console.log('  This is the expected state before the implementation exists:' +
    ' the oracle is built first.');
  console.log('  The suite verifies the spec, not the code -- there is nothing' +
    ' to check until the tool runs.');
  cleanup();
  process.exit(1);
}

export function requireBin(name: string): void {
  if (!fs.existsSync(binPath(name))) {
    abortNoImplementation(name + ' not found at ' + binPath(name));
  }
}

export interface RunBinOpts {
  env?: Record<string, string>;
  gnupgHome?: string;
  cwd?: string;
  input?: string;
  timeout?: number;
}

export interface RunBinResult {
  status: number | null;
  stdout: string;
  stderr: string;
  signal?: NodeJS.Signals | null;
  missing?: string;
}

/**
 * Run a bin/* tool. Returns {status, stdout, stderr, signal, missing}.
 * Never throws on a non-zero exit -- that is data, not an error.
 * opts.env merges over process.env; opts.gnupgHome sets GNUPGHOME. A caller
 * that omits gnupgHome gets a guaranteed-nonexistent GNUPGHOME instead of
 * silently inheriting the real ~/.gnupg (noGnupgHome()) -- a test that
 * forgets to wire up its throwaway key fails loudly, it never reads or
 * writes the user's own keyring.
 */
export function runBin(name: string, args: string[], opts?: RunBinOpts): RunBinResult {
  const o = opts || {};
  const p = binPath(name);
  if (!fs.existsSync(p)) return { status: null, stdout: '', stderr: '', missing: name + ' not found at ' + p };
  const env = Object.assign({}, process.env, o.env || {});
  env.GNUPGHOME = o.gnupgHome || noGnupgHome();
  const r = spawnSync(p, args, {
    cwd: o.cwd,
    env,
    input: o.input,
    encoding: 'utf8',
    timeout: o.timeout || 30000,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (r.error) {
    return { status: null, stdout: '', stderr: String(r.error.message), missing: 'spawn failed: ' + r.error.message };
  }
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', signal: r.signal };
}

/* ------------------------------------------------------------------ */
/* Throwaway GPG identity -- a fresh GNUPGHOME under /tmp with its own  */
/* freshly generated ed25519 key. Every git/gpg call passes GNUPGHOME   */
/* explicitly; the real ~/.gnupg and the project's own signing key are */
/* never read or touched.                                              */
/* ------------------------------------------------------------------ */

export interface Gpg {
  gnupgHome: string;
  fingerprint: string;
  env: NodeJS.ProcessEnv;
}

/* The committer/key identity every fixture repo uses. It is itself
 * email-shaped, so leak-scan's built-in `email` category legitimately
 * flags it in EVERY fixture commit's author/committer line -- a test
 * asserting a scan comes back clean (exit 0) must --allow this exact
 * string, or it is testing an artifact of the fixture, not the tool. */
export const FIXTURE_EMAIL = 'ght-test@example.invalid';

/**
 * Generates one throwaway identity. Returns {gnupgHome, fingerprint, env}
 * or null (with a T.check failure already recorded) if key generation
 * failed -- callers should bail out of the rest of their fixture when that
 * happens, since nothing downstream can sign without it.
 */
export function setupGpg(label?: string): Gpg | null {
  const gnupgHome = freshDir((label || 'gnupg') + '-home');
  fs.chmodSync(gnupgHome, 0o700);
  _gnupgHomes.push(gnupgHome);
  const batch = path.join(gnupgHome, 'batch.txt');
  fs.writeFileSync(batch,
    '%no-protection\nKey-Type: eddsa\nKey-Curve: ed25519\n' +
    'Name-Real: GHT Test\nName-Email: ' + FIXTURE_EMAIL + '\n' +
    'Expire-Date: 0\n%commit\n');
  const gen = spawnSync('gpg', ['--batch', '--gen-key', batch],
    { env: Object.assign({}, process.env, { GNUPGHOME: gnupgHome }), encoding: 'utf8', timeout: 30000 });
  if (gen.status !== 0) {
    T.check('fixture: gpg --batch --gen-key (throwaway key)', false, gen.stderr);
    return null;
  }
  const list = spawnSync('gpg', ['--batch', '--list-secret-keys', '--with-colons'],
    { env: Object.assign({}, process.env, { GNUPGHOME: gnupgHome }), encoding: 'utf8', timeout: 15000 });
  const m = /^fpr:::::::::([0-9A-F]+):/m.exec(list.stdout || '');
  const fingerprint = m ? m[1] : null;
  T.check('fixture: parsed a fingerprint for the throwaway key', !!fingerprint, list.stdout);
  if (!fingerprint) return null;
  return { gnupgHome, fingerprint, env: Object.assign({}, process.env, { GNUPGHOME: gnupgHome }) };
}

/* ------------------------------------------------------------------ */
/* Fixture git repos                                                   */
/* ------------------------------------------------------------------ */

/**
 * A fresh git repo under /tmp, configured to sign with the given throwaway
 * gpg identity (see setupGpg). Returns the repo dir.
 */
export function initRepo(label: string | undefined, gpg: Gpg): string {
  const dir = freshDir(label || 'repo');
  const git = (args: string[]) => spawnSync('git', args, { cwd: dir, env: gpg.env, encoding: 'utf8' });
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', FIXTURE_EMAIL]);
  git(['config', 'user.name', 'GHT Test']);
  git(['config', 'user.signingkey', gpg.fingerprint]);
  git(['config', 'gpg.program', 'gpg']);
  git(['config', 'commit.gpgsign', 'true']);
  git(['config', 'tag.gpgsign', 'true']);
  return dir;
}

export function gitIn(repo: string, gpg: Gpg) {
  return (args: string[], opts?: Record<string, unknown>) =>
    spawnSync('git', args, Object.assign({ cwd: repo, env: gpg.env, encoding: 'utf8' as const }, opts || {}));
}

export interface CommitOpts {
  date?: string;
  mode?: Record<string, number>;
  remove?: string[];
}

export interface CommitResult {
  status: number | null;
  stdout: string;
  stderr: string;
  sha: string | null;
}

/**
 * Writes `files` (a {relPath: content-or-Buffer} map) into the repo's
 * working tree, `git add`s and signed-commits them. Returns {status,
 * stdout, stderr, sha} (sha is the new commit's full hash, or null on
 * failure). `opts.date` sets GIT_AUTHOR_DATE/GIT_COMMITTER_DATE (git's own
 * "@<unix> <tz>" or ISO form); `opts.mode` may mark a relPath executable.
 */
export function commit(repo: string, gpg: Gpg, message: string, files?: Record<string, string | Buffer>, opts?: CommitOpts): CommitResult {
  const o = opts || {};
  const git = gitIn(repo, gpg);
  for (const [rel, content] of Object.entries(files || {})) {
    const p = path.join(repo, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
    if (o.mode && o.mode[rel]) fs.chmodSync(p, o.mode[rel]);
  }
  for (const rel of o.remove || []) {
    try { fs.unlinkSync(path.join(repo, rel)); } catch (e) { /* ignore */ }
  }
  git(['add', '-A']);
  const env: Record<string, string> = {};
  if (o.date) { env.GIT_AUTHOR_DATE = o.date; env.GIT_COMMITTER_DATE = o.date; }
  const r = git(['commit', '-q', '-m', message], { env: Object.assign({}, gpg.env, env) });
  if (r.status !== 0) return { status: r.status, stdout: r.stdout, stderr: r.stderr, sha: null };
  const head = git(['rev-parse', 'HEAD']);
  return { status: 0, stdout: r.stdout, stderr: r.stderr, sha: (head.stdout || '').trim() };
}

/** A signed annotated tag. */
export function tagSigned(repo: string, gpg: Gpg, name: string, message?: string) {
  const git = gitIn(repo, gpg);
  return git(['tag', '-s', name, '-m', message || ('tag ' + name)]);
}

/** An unsigned annotated tag (fixture for "a signature the tool should still
 * handle as a tag, verification concerns aside"). The fixture repo sets
 * tag.gpgsign=true (a realistic config the tools must cope with, not an
 * artifact of the test setup) -- `-c tag.gpgsign=false` overrides it for
 * this one call so the tag this function's own name promises is genuinely
 * unsigned, not silently signed anyway. */
export function tagAnnotatedUnsigned(repo: string, gpg: Gpg, name: string, message?: string) {
  const git = gitIn(repo, gpg);
  return git(['-c', 'tag.gpgsign=false', 'tag', '-a', name, '-m', message || ('tag ' + name)]);
}

/** A lightweight tag -- just a ref, no tag object. `-c tag.gpgsign=false`
 * is required for the same reason: with tag.gpgsign=true in the fixture's
 * own config, plain `git tag <name>` otherwise refuses with "no tag
 * message?" -- git silently upgrades it to an annotated, signed tag and
 * then finds no -m/-F to sign it with. */
export function tagLightweight(repo: string, gpg: Gpg, name: string, ref?: string) {
  const git = gitIn(repo, gpg);
  return git(['-c', 'tag.gpgsign=false', 'tag', name].concat(ref ? [ref] : []));
}

export function revParse(repo: string, gpg: Gpg, rev: string): string {
  const git = gitIn(repo, gpg);
  const r = git(['rev-parse', rev]);
  return (r.stdout || '').trim();
}

export function shortSha(repo: string, gpg: Gpg, rev: string): string {
  const git = gitIn(repo, gpg);
  const r = git(['rev-parse', '--short', rev]);
  return (r.stdout || '').trim();
}

export function log(repo: string, gpg: Gpg, args?: string[]): string {
  const git = gitIn(repo, gpg);
  const r = git(['log'].concat(args || ['--oneline', '--all']));
  return r.stdout || '';
}

/** Any git subcommand, verbatim -- `log()` always prepends 'log' itself,
 * so a caller wanting e.g. `git show-ref` (not `git log show-ref`) uses
 * this instead. Returns stdout, trimmed of nothing (callers trim/parse
 * as needed; `git show-ref`'s own blank-when-empty output matters as-is). */
export function gitRaw(repo: string, gpg: Gpg, args: string[]): string {
  const git = gitIn(repo, gpg);
  const r = git(args);
  return r.stdout || '';
}

/** The single `<repo-basename>.backup-<UTC>.bundle` sibling of a fixture
 * repo, or null if none/ambiguous (every fixture repo's parent dir is
 * TMP_ROOT, same invariant sweepBackupBundles() relies on). */
export function findBackupBundle(repo: string): string | null {
  const base = path.basename(repo);
  const dir = path.dirname(repo);
  let names: string[];
  try { names = fs.readdirSync(dir); } catch (e) { return null; }
  const entries = names.filter(n => n.startsWith(base + '.backup-') && n.endsWith('.bundle'));
  return entries.length === 1 ? path.join(dir, entries[0]) : null;
}

/** Parses `git bundle list-heads <path>` into { refname: sha }. Lets a
 * test compare a bundled ref's sha against a PRE-run sha captured before
 * the rewrite -- a backup bundle created after the write would instead
 * carry the NEW (rewritten) sha for the same ref name. */
export function bundleListHeads(bundlePath: string): Record<string, string> {
  const r = spawnSync('git', ['bundle', 'list-heads', bundlePath], { encoding: 'utf8' });
  const out: Record<string, string> = {};
  for (const line of (r.stdout || '').split('\n')) {
    const m = /^([0-9a-f]{4,40})\s+(\S+)$/.exec(line.trim());
    if (m) out[m[2]] = m[1];
  }
  return out;
}

/** The repo's current branch name (e.g. "main"), for building a
 * `refs/heads/<branch>` key into bundleListHeads()'s map. */
export function branchName(repo: string, gpg: Gpg): string {
  return gitRaw(repo, gpg, ['symbolic-ref', '--short', 'HEAD']).trim();
}

export function treeOf(repo: string, gpg: Gpg, rev: string): string {
  const git = gitIn(repo, gpg);
  const r = git(['rev-parse', rev + '^{tree}']);
  return (r.stdout || '').trim();
}

export function catFile(repo: string, gpg: Gpg, rev: string, type?: string): string {
  const git = gitIn(repo, gpg);
  const r = git(['cat-file', type || '-p', rev]);
  return r.stdout || '';
}

export interface ObjectStoreSnapshot {
  files: string[];
  countObjects: string;
}

/**
 * A snapshot of the object store (D2): every path under `.git/objects`
 * (recursive, sorted -- this catches a new loose object OR a new pack),
 * plus `git count-objects -v`'s own report. A dry run must leave both
 * byte-identical to before it ran.
 */
export function objectStoreSnapshot(repo: string, gpg: Gpg): ObjectStoreSnapshot {
  const root = path.join(repo, '.git', 'objects');
  const files: string[] = [];
  (function walk(dir: string, rel: string) {
    let names: string[];
    try { names = fs.readdirSync(dir); } catch (e) { return; }
    for (const n of names.sort()) {
      const abs = path.join(dir, n);
      const r = rel ? rel + '/' + n : n;
      let st;
      try { st = fs.statSync(abs); } catch (e) { continue; }
      if (st.isDirectory()) walk(abs, r);
      else files.push(r);
    }
  })(root, '');
  const git = gitIn(repo, gpg);
  const count = git(['count-objects', '-v']);
  return { files, countObjects: count.stdout || '' };
}

export interface ObjectStoreDiff {
  added: string[];
  removed: string[];
  countChanged: boolean;
}

/** True description of how two objectStoreSnapshot() results differ, for
 * a failure message -- which files appeared/disappeared and whether the
 * count-objects report itself changed. */
export function objectStoreDiff(before: ObjectStoreSnapshot, after: ObjectStoreSnapshot): ObjectStoreDiff {
  const added = after.files.filter(f => !before.files.includes(f));
  const removed = before.files.filter(f => !after.files.includes(f));
  const countChanged = before.countObjects !== after.countObjects;
  return { added, removed, countChanged };
}

/* ------------------------------------------------------------------ */
/* Test context                                                        */
/* ------------------------------------------------------------------ */

interface Failure {
  desc: string;
  detail: string;
}

export const T = {
  _failures: [] as Failure[],
  _checks: 0,
  _name: path.basename(process.argv[1] || 'test'),

  check(desc: string, cond: unknown, detail?: unknown): boolean {
    this._checks++;
    if (!cond) this._failures.push({ desc, detail: detail === undefined ? '' : String(detail) });
    return !!cond;
  },

  eq(desc: string, actual: unknown, expected: unknown): boolean {
    const a = typeof actual === 'string' ? actual : JSON.stringify(actual);
    const e = typeof expected === 'string' ? expected : JSON.stringify(expected);
    return this.check(desc, a === e, 'expected ' + JSON.stringify(e) + '\n     got      ' + JSON.stringify(a));
  },

  exit(desc: string, result: RunBinResult, expected: number): boolean {
    if (Array.isArray(expected)) {
      throw new Error('T.exit(' + JSON.stringify(desc) + ', ...): expected must be a single ' +
        'exit code, not an array -- pin one value from the spec instead of tolerating a set');
    }
    if (result.missing) {
      return this.check(desc, false, 'CANNOT RUN: ' + result.missing +
        '\n     (the implementation does not exist yet -- the oracle is built first)');
    }
    const ok = result.status === expected;
    return this.check(desc, ok,
      'expected exit ' + expected + ', got ' + result.status +
      (result.stderr ? '\n     stderr: ' + trunc(result.stderr) : ''));
  },

  contains(desc: string, haystack: unknown, needle: string): boolean {
    return this.check(desc, String(haystack).includes(needle),
      'expected to contain ' + JSON.stringify(needle) + '\n     in  ' + JSON.stringify(trunc(haystack)));
  },

  finish(): void {
    const name = this._name;
    if (this._failures.length === 0) {
      console.log('PASS ' + name + ' (' + this._checks + ' checks)');
      cleanup();
      process.exit(0);
    }
    console.log('FAIL ' + name + ' -- ' + this._failures.length + ' of ' + this._checks + ' checks failed');
    for (const f of this._failures) {
      console.log('  x ' + f.desc);
      if (f.detail) console.log('    ' + f.detail);
    }
    cleanup();
    process.exit(1);
  },
};

function trunc(s: unknown, n?: number): string {
  const str = String(s);
  const limit = n || 400;
  return str.length > limit ? str.slice(0, limit) + '...' : str;
}

/** Every `<repo>.backup-<UTC>.bundle` a test's own fixture repos could
 * have caused (D2): the bundle sits NEXT TO the repo (§ 4.1), i.e. as a
 * direct sibling file in the repo's own parent directory -- which, for
 * every fixture built via freshDir()/initRepo(), is always TMP_ROOT
 * itself. Removing the repo dir alone (plain fs.rmSync) never touches
 * this sibling, so without this sweep a bundle outlives every fixture
 * that caused one. */
function sweepBackupBundles(): void {
  for (const d of _tmpDirs) {
    const dir = path.dirname(d);
    const base = path.basename(d);
    let names: string[];
    try { names = fs.readdirSync(dir); } catch (e) { continue; }
    for (const n of names) {
      if (n.startsWith(base + '.backup-') && n.endsWith('.bundle')) {
        try { fs.rmSync(path.join(dir, n), { force: true }); } catch (e) { /* best effort */ }
      }
    }
  }
}

function cleanup(): void {
  if (process.env.GHT_KEEP === '1') return;
  sweepBackupBundles();
  for (const d of _tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* best effort */ }
  }
}
