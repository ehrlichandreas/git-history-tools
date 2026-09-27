/* Shared CLI plumbing: usage errors (exit 2) vs refusals (exit 1), and a
 * small flag parser used by all three bin entry points. */
import path from 'node:path';
import fs from 'node:fs';

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
 * Parses `--flag=value` / `--flag value` / `--bool-flag` style args.
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
        else { i++; value = args[i]; }
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

/** Resolves a --rules/--terms/--allow style path, applying the shared rules:
 * must exist (usage error otherwise), must not resolve inside <repo>
 * (refusal otherwise). flagName is e.g. '--rules'. The containment check
 * resolves symlinks in the parent directory only, not the file's own final
 * path segment -- a symlink that itself lives inside the repo is caught
 * even when it points to a file outside, since the symlink would still get
 * committed the next time the repo's own history is rewritten. */
export function resolveOutsideFile(repo: string, flagName: string, filePath: string): string {
  if (!fs.existsSync(filePath)) {
    throw new UsageError(flagName + ' file does not exist: ' + filePath);
  }
  const abs = path.resolve(filePath);
  const realDir = fs.realpathSync(path.dirname(abs));
  const realFile = path.join(realDir, path.basename(abs));
  const realRepo = fs.realpathSync(repo);
  const rel = path.relative(realRepo, realFile);
  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
    throw new Refusal(flagName + ' points inside the repo (' + filePath + ') -- keep it outside');
  }
  return fs.realpathSync(filePath);
}

/** Top-level dispatcher: runs fn(), prints via the <bin>: <reason> contract,
 * and sets the right exit code for UsageError (2) vs Refusal (1). `bin` is
 * the name the user invoked (e.g. 'git-release-squash'), not the lib file's own
 * basename -- those differ since every tool's logic lives in lib/<tool>.ts
 * but is invoked via bin/<tool>. */
export function main(bin: string, fn: (bin: string) => void): void {
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
