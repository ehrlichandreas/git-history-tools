/*
 * Thin git wrapper shared by all three tools. Every call takes the repo
 * directory explicitly (-C <repo>), never relies on process.cwd().
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';

export interface RunOpts {
  env?: NodeJS.ProcessEnv;
  config?: string[];
  input?: string | Buffer;
  raw?: boolean;
}

export interface RunResult {
  status: number | null;
  stdout: string | Buffer;
  stderr: string;
}

export class GitError extends Error {
  args: string[];
  result: RunResult;

  constructor(args: string[], result: RunResult) {
    super('git ' + args.join(' ') + ' failed: ' + (result.stderr || '').trim());
    this.args = args;
    this.result = result;
  }
}

/** The variables git reads before any `-C <repo>`: `git rev-parse
 * --local-env-vars` of git 2.53, a fixed list (AC-81 turns red if a newer
 * git lists one more). Set by a caller, GIT_DIR made `replace A` rewrite
 * another repository and GIT_CONFIG_PARAMETERS reached every git call
 * (D21). */
export const CALLER_GIT_ENV: readonly string[] = [
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CONFIG', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT',
  'GIT_OBJECT_DIRECTORY', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_IMPLICIT_WORK_TREE', 'GIT_GRAFT_FILE',
  'GIT_INDEX_FILE', 'GIT_NO_REPLACE_OBJECTS', 'GIT_REPLACE_REF_BASE', 'GIT_PREFIX', 'GIT_SHALLOW_FILE',
  'GIT_COMMON_DIR',
];

/** The caller's variables a tool removes from its own environment before
 * anything else (cli.ts `main`, D21): CALLER_GIT_ENV plus the
 * GIT_CONFIG_KEY_<n>/GIT_CONFIG_VALUE_<n> that GIT_CONFIG_COUNT counts.
 * Nothing is refused for being set -- a tool run from a git hook, which
 * sets GIT_DIR, keeps working -- `<repo>` alone decides. git-sign adds its
 * own GIT_CONFIG_* pins afterwards. */
export function callerGitEnvNames(env: NodeJS.ProcessEnv): string[] {
  return Object.keys(env).filter((k) => CALLER_GIT_ENV.includes(k) || /^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(k));
}

/** The only caller config that comes back after the strip (Lead's
 * allowlist, D21): identity is not code and cannot redirect the target,
 * and a release script passes the owner's this way. */
const IDENTITY_KEYS = ['user.name', 'user.email', 'user.signingkey'];

/** The caller's GIT_CONFIG_COUNT entries whose key is user.name,
 * user.email or user.signingkey (any case, as git matches keys), in order.
 * GIT_CONFIG_PARAMETERS gives none: identity goes via the COUNT family. */
export function callerIdentityConfig(env: NodeJS.ProcessEnv): [string, string][] {
  const n = parseInt(env.GIT_CONFIG_COUNT || '', 10);
  const out: [string, string][] = [];
  for (let i = 0; i < (n > 0 ? n : 0); i++) {
    const k = env['GIT_CONFIG_KEY_' + i];
    const v = env['GIT_CONFIG_VALUE_' + i];
    if (k !== undefined && v !== undefined && IDENTITY_KEYS.includes(k.toLowerCase())) out.push([k, v]);
  }
  return out;
}

/** `pairs` as a GIT_CONFIG_COUNT family, numbered from 0. */
export function configCountEnv(pairs: [string, string][]): Record<string, string> {
  if (pairs.length === 0) return {};
  return Object.assign({ GIT_CONFIG_COUNT: String(pairs.length) },
    ...pairs.map(([k, v], i) => ({ ['GIT_CONFIG_KEY_' + i]: k, ['GIT_CONFIG_VALUE_' + i]: v })));
}

/** Config every git call runs with (D21, AC-82): the repository's own
 * hooks (`pre-commit`, `commit-msg`, `post-commit` under `git commit`, a
 * `reference-transaction` hook under every `update-ref`) and its
 * `core.fsmonitor` (under `status`) are code it would run on our behalf. */
const NO_REPO_CODE = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false'];

/** ght reads and writes UTF-8 only (D21, D23, AC-106). A repository's
 * `i18n.commitEncoding` made `commit-tree` and `git commit` stamp
 * `encoding <it>` over the UTF-8 bytes they were given, and
 * `i18n.logOutputEncoding` (which defaults to it) made `log --format`
 * hand over a message re-encoded away from UTF-8. A source commit in
 * another encoding is refused before any write (encoding.ts), so a new
 * commit gets no header; an explicit UTF-8 one is dropped (replace) or
 * refused (resign-commits, AC-107). */
const UTF8_ONLY = ['-c', 'i18n.commitEncoding=UTF-8', '-c', 'i18n.logOutputEncoding=UTF-8'];

/** Runs git, returns {status, stdout (Buffer), stderr (string)}. Never throws.
 * Whatever `env` holds, CALLER_GIT_ENV never reaches git, except the
 * GIT_CONFIG_COUNT family, which by now can only be the caller's identity
 * entries that `main` put back and git-sign's own pins after them (D21). Replace refs are off: every tool sees the objects `git push`
 * sends, not what `refs/replace/*` swaps in (D21, AC-96). */
export function run(repo: string, args: string[], opts?: RunOpts): RunResult {
  const o = opts || {};
  const env = Object.assign({}, process.env, o.env || {});
  for (const k of CALLER_GIT_ENV) if (k !== 'GIT_CONFIG_COUNT') delete env[k];
  env.GIT_NO_REPLACE_OBJECTS = '1';
  const pre = NO_REPO_CODE.concat(UTF8_ONLY, o.config || []);
  const r = spawnSync('git', ['-C', repo].concat(pre, args), {
    env,
    input: o.input,
    encoding: o.raw ? null : 'utf8',
    maxBuffer: 1 << 30,
  });
  return {
    status: r.status,
    stdout: r.stdout == null ? (o.raw ? Buffer.alloc(0) : '') : r.stdout,
    stderr: r.stderr == null ? '' : (o.raw ? (r.stderr as Buffer).toString('utf8') : (r.stderr as string)),
  };
}

/** Runs git, returns trimmed stdout text; throws GitError on non-zero exit. */
export function text(repo: string, args: string[], opts?: RunOpts): string {
  const r = run(repo, args, opts);
  if (r.status !== 0) throw new GitError(args, r);
  return (r.stdout as string).replace(/\n$/, '');
}

/** Runs git, returns raw stdout Buffer; throws GitError on non-zero exit. */
export function buffer(repo: string, args: string[], opts?: RunOpts): Buffer {
  const r = run(repo, args, Object.assign({}, opts, { raw: true }));
  if (r.status !== 0) throw new GitError(args, r);
  return r.stdout as Buffer;
}

/** true iff <dir> looks like a git repository (has a resolvable .git). */
export function isRepo(dir: string): boolean {
  const r = run(dir, ['rev-parse', '--git-dir']);
  return r.status === 0;
}

/** The top level of the repository <dir> is in: the work tree's root, or a
 * bare repository's own git dir; for a work tree's .git dir, the work tree
 * (AC-80). null if <dir> is in no repository. `rev-parse --git-dir` alone
 * succeeds anywhere inside a work tree, so <dir> may well be a
 * subdirectory -- compare the result with <dir> itself (requireRepo). */
export function topLevel(dir: string): string | null {
  const b = run(dir, ['rev-parse', '--is-bare-repository', '--absolute-git-dir', '--is-inside-git-dir']);
  if (b.status !== 0) return null;
  const [bare, gitDir, insideGitDir] = (b.stdout as string).split('\n');
  if (bare === 'true') return gitDir;
  /* Inside a work tree's git dir (`<repo>/.git`), git has no top level to
   * show; `core.worktree` names it, or else the git dir's parent is it. */
  if (insideGitDir === 'true') {
    const wt = run(gitDir, ['config', '--get', 'core.worktree']);
    if (wt.status === 0) return path.resolve(gitDir, (wt.stdout as string).replace(/\n$/, ''));
    return path.basename(gitDir) === '.git' ? path.dirname(gitDir) : null;
  }
  const t = run(dir, ['rev-parse', '--show-toplevel']);
  return t.status === 0 ? (t.stdout as string).replace(/\n$/, '') : null;
}

export interface RefMove {
  ref: string;
  newSha: string;
  /** The value the ref must still have; null: it must not exist yet. */
  oldSha: string | null;
}

/** Moves every ref in `moves` in ONE `update-ref --stdin` transaction, each
 * checked against its old value: all of them or none (D20, AC-74; the same
 * shape git-sign's resign-* use). Never throws; the caller turns a
 * non-zero status into its own refusal. */
export function moveRefs(repo: string, env: NodeJS.ProcessEnv, message: string, moves: RefMove[]): RunResult {
  const lines = ['start'];
  for (const m of moves) {
    lines.push(m.oldSha === null ? 'create ' + m.ref + ' ' + m.newSha : 'update ' + m.ref + ' ' + m.newSha + ' ' + m.oldSha);
  }
  lines.push('prepare', 'commit');
  return run(repo, ['update-ref', '-m', message, '--stdin'], { env, input: lines.join('\n') + '\n' });
}

/** The ident git itself would write as committer/tagger under `env`
 * (`Name <email> <epoch> <tz>`): the same one `git tag` uses for its
 * `tagger` line, so a tag object built by hand matches it. */
export function committerIdent(repo: string, env: NodeJS.ProcessEnv): string {
  return text(repo, ['var', 'GIT_COMMITTER_IDENT'], { env });
}

/** A ref's name inside its namespace (`refs/tags/x` -> `x`), cut from the
 * FULL refname. Never `%(refname:short)` or `symbolic-ref --short`: when a
 * branch and a tag share a name they print `heads/x`/`tags/x`, and a tool
 * that prefixed that again moved `refs/tags/tags/x`, a new ref, while the
 * real one stayed on the old history (D20, AC-72). */
export function refBase(ref: string, namespace: 'refs/heads/' | 'refs/tags/'): string {
  if (!ref.startsWith(namespace)) throw new Error('refBase: ' + ref + ' is not under ' + namespace);
  return ref.slice(namespace.length);
}

/** Whether <name> may name a NEW tag: `git check-ref-format
 * refs/tags/<name>` accepts it, and it does not start with `-` (which
 * check-ref-format allows but git tag and any argv refuse). Needs no
 * repository. Checked before anything else, so a bad name never gets as
 * far as a write (D20, AC-73). */
export function isValidTagName(name: string): boolean {
  if (name === '' || name.startsWith('-')) return false;
  return spawnSync('git', ['check-ref-format', 'refs/tags/' + name], { encoding: 'utf8' }).status === 0;
}

export function configGet(repo: string, key: string, opts?: RunOpts): string | null {
  const r = run(repo, ['config', '--get', key], opts);
  if (r.status !== 0) return null;
  return (r.stdout as string).replace(/\n$/, '');
}
