/*
 * Thin git wrapper shared by all three tools. Every call takes the repo
 * directory explicitly (-C <repo>), never relies on process.cwd().
 */
import { spawnSync } from 'node:child_process';

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

/** Runs git, returns {status, stdout (Buffer), stderr (string)}. Never throws. */
export function run(repo: string, args: string[], opts?: RunOpts): RunResult {
  const o = opts || {};
  const env = Object.assign({}, process.env, o.env || {});
  const pre = o.config || [];
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

export function configGet(repo: string, key: string, opts?: RunOpts): string | null {
  const r = run(repo, ['config', '--get', key], opts);
  if (r.status !== 0) return null;
  return (r.stdout as string).replace(/\n$/, '');
}
