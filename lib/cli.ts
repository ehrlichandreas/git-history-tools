/* Shared CLI plumbing: usage errors (exit 2) vs refusals (exit 1), and a
 * small flag parser used by all four bin entry points. */
import path from 'node:path';
import fs from 'node:fs';
import * as git from './git.ts';

export class UsageError extends Error {}
export class Refusal extends Error {}

export interface FlagSpec {
  valueFlags?: string[];
  boolFlags?: string[];
}

export interface ParsedFlags {
  positional: string[];
  flags: Record<string, string | boolean>;
}

/**
 * Parses `--flag=value` / `--flag value` / `--bool-flag` style args (a
 * space-separated value may not itself start with `--`).
 * spec: { valueFlags: ['--map', '--name', ...], boolFlags: ['--apply', ...] }
 * Returns { positional: [...], flags: {name: value-or-true} }.
 * Throws UsageError on an unrecognised flag or a value flag missing its value.
 */
export function parseFlags(args: string[], spec: FlagSpec): ParsedFlags {
  const valueFlags = new Set(spec.valueFlags || []);
  const boolFlags = new Set(spec.boolFlags || []);
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = eq === -1 ? a : a.slice(0, eq);
      if (valueFlags.has(name)) {
        let value: string | undefined;
        if (eq !== -1) value = a.slice(eq + 1);
        else {
          i++;
          value = args[i];
          /* `--message --apply` must not silently take `--apply` as the
           * message (and so quietly drop the flag): a space-separated value
           * that is itself a flag is a missing value. `--message=--x` still
           * passes a value starting with `--` explicitly. */
          if (value !== undefined && value.startsWith('--')) value = undefined;
        }
        if (value === undefined) throw new UsageError('missing value for ' + name);
        flags[name.slice(2)] = value;
      } else if (boolFlags.has(name)) {
        if (eq !== -1) throw new UsageError('unknown flag \'' + a + '\'');
        flags[name.slice(2)] = true;
      } else {
        throw new UsageError('unknown flag \'' + a + '\'');
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

/** § 0: <repo> must be a git repository, and its top level -- never a
 * subdirectory of a work tree, whose history every tool would otherwise
 * read and rewrite relative to that subdirectory (AC-70). Symlinks and a
 * trailing slash are resolved before comparing. */
export function requireRepo(repo: string): void {
  if (!git.isRepo(repo)) throw new Refusal('not a git repository (' + repo + ')');
  const top = git.topLevel(repo);
  if (top === null || fs.realpathSync(top) !== fs.realpathSync(repo)) {
    throw new Refusal('not the top level of its repository (' + repo + '; the top level is ' +
      (top === null ? 'unknown' : fs.realpathSync(top)) + ')');
  }
}

/** Resolves a --rules/--terms/--allow style path, applying the shared rules:
 * must exist (usage error otherwise), must not resolve inside <repo>
 * (refusal otherwise). flagName is e.g. '--rules'. Two separate containment
 * checks, both must pass:
 * - symlinks in the parent directory resolved, but the path's own final
 *   segment kept as-is -- catches a symlink that itself lives inside the
 *   repo even when it points to a file outside, since the symlink would
 *   still get committed the next time the repo's own history is rewritten;
 * - every symlink fully resolved, including the final segment -- catches
 *   a symlink living outside the repo (so the first check alone sees it as
 *   outside) whose target is itself inside the repo. */
export function isInsideRepo(realRepo: string, candidate: string): boolean {
  const rel = path.relative(realRepo, candidate);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export function resolveOutsideFile(repo: string, flagName: string, filePath: string): string {
  if (!fs.existsSync(filePath)) {
    throw new UsageError(flagName + ' file does not exist: ' + filePath);
  }
  const abs = path.resolve(filePath);
  const realRepo = fs.realpathSync(repo);

  const realDir = fs.realpathSync(path.dirname(abs));
  const realFileShallow = path.join(realDir, path.basename(abs));
  const realFileFull = fs.realpathSync(abs);

  if (isInsideRepo(realRepo, realFileShallow) || isInsideRepo(realRepo, realFileFull)) {
    throw new Refusal(flagName + ' points inside the repo (' + filePath + ') -- keep it outside');
  }
  return realFileFull;
}

/** Reads a file the caller named (a flag's value or a positional). Missing,
 * a directory or unreadable is one usage-error line naming `label` and
 * the path, never a stack trace (D23, AC-102). */
export function readUserFile(label: string, file: string): Buffer {
  try {
    return fs.readFileSync(file);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    const why = code === 'ENOENT' ? 'no such file' : code === 'EISDIR' ? 'is a directory' :
      code === 'EACCES' ? 'permission denied' : 'cannot read (' + (code || (e as Error).message) + ')';
    throw new UsageError(label + ': ' + why + ': ' + file);
  }
}

const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** `bytes` as text, for a message file the caller named (`file`, `-` for
 * stdin). Bytes that are not valid UTF-8 are one usage-error line, not
 * U+FFFD in the object written (D23, AC-105). */
export function decodeUserText(label: string, file: string, bytes: Buffer): string {
  try {
    return UTF8.decode(bytes);
  } catch {
    throw new UsageError(label + ': not valid UTF-8: ' + file);
  }
}

const HELP_WORDS = ['--help', '-h', 'help'];

/** § 0: `<bin> --help`/`-h`/`help` prints `usage:` and every synopsis on
 * stdout, `<bin> <sub> --help` (or `-h`) prints `usage: <its synopsis>`,
 * both before any flag parsing, so they never fail on the arguments
 * around them. Returns true when it printed (the run is then exit 0). */
export function printHelp(sub: string | undefined, rest: string[], synopses: Record<string, string>, footer: string): boolean {
  if (sub === undefined) return false;
  if (HELP_WORDS.includes(sub)) {
    process.stdout.write('usage:\n' + Object.values(synopses).map((l) => '  ' + l + '\n').join('') + footer + '\n');
    return true;
  }
  if (Object.hasOwn(synopses, sub) && (rest.includes('--help') || rest.includes('-h'))) {
    process.stdout.write('usage: ' + synopses[sub] + '\n');
    return true;
  }
  return false;
}

/** Top-level dispatcher: runs fn(), prints via the <bin>: <reason> contract,
 * and sets the right exit code for UsageError (2) vs Refusal (1). `bin` is
 * the name the user invoked (e.g. 'git-release-squash'), not the lib file's own
 * basename -- those differ since every tool's logic lives in lib/<tool>.ts
 * but is invoked via bin/<tool>. */
export function main(bin: string, fn: (bin: string) => void): void {
  const identity = git.callerIdentityConfig(process.env);
  for (const k of git.callerGitEnvNames(process.env)) delete process.env[k];
  /* The caller's identity alone comes back; git-sign appends its pins after it (D21, AC-81). */
  Object.assign(process.env, git.configCountEnv(identity));
  /* Also for what runs under us (gpg, a --hook): the objects push sends (D21, AC-96). */
  process.env.GIT_NO_REPLACE_OBJECTS = '1';
  try {
    fn(bin);
  } catch (e) {
    if (e instanceof UsageError) {
      process.stderr.write(bin + ': ' + e.message + '\n');
      process.exit(2);
    }
    if (e instanceof Refusal) {
      process.stderr.write(bin + ': ' + e.message + '\n');
      process.exit(1);
    }
    throw e;
  }
}
