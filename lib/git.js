'use strict';
/*
 * Thin git wrapper shared by all three tools. Every call takes the repo
 * directory explicitly (-C <repo>), never relies on process.cwd().
 */
const { spawnSync } = require('child_process');

class GitError extends Error {
  constructor(args, result) {
    super('git ' + args.join(' ') + ' failed: ' + (result.stderr || '').trim());
    this.args = args;
    this.result = result;
  }
}

/** Runs git, returns {status, stdout (Buffer), stderr (string)}. Never throws. */
function run(repo, args, opts) {
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
    stderr: r.stderr == null ? '' : (o.raw ? r.stderr.toString('utf8') : r.stderr),
  };
}

/** Runs git, returns trimmed stdout text; throws GitError on non-zero exit. */
function text(repo, args, opts) {
  const r = run(repo, args, opts);
  if (r.status !== 0) throw new GitError(args, r);
  return r.stdout.replace(/\n$/, '');
}

/** Runs git, returns raw stdout Buffer; throws GitError on non-zero exit. */
function buffer(repo, args, opts) {
  const r = run(repo, args, Object.assign({}, opts, { raw: true }));
  if (r.status !== 0) throw new GitError(args, r);
  return r.stdout;
}

/** true iff <dir> looks like a git repository (has a resolvable .git). */
function isRepo(dir) {
  const r = run(dir, ['rev-parse', '--git-dir']);
  return r.status === 0;
}

function configGet(repo, key, opts) {
  const r = run(repo, ['config', '--get', key], opts);
  if (r.status !== 0) return null;
  return r.stdout.replace(/\n$/, '');
}

module.exports = { GitError, run, text, buffer, isRepo, configGet };
