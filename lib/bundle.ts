/* § 4.1: the backup bundle, created before any ref is touched. */
import fs from 'node:fs';
import path from 'node:path';
import * as git from './git.ts';

function utcStamp(d: Date): string {
  const p = (n: number, w?: number) => String(n).padStart(w || 2, '0');
  return d.getUTCFullYear() + p(d.getUTCMonth() + 1) + p(d.getUTCDate()) +
    'T' + p(d.getUTCHours()) + p(d.getUTCMinutes()) + p(d.getUTCSeconds()) + 'Z';
}

/** Creates <parent-of-top>/<top-basename>.backup-<UTC>.bundle, --all,
 * capturing every ref as it stands right now. Returns the bundle path.
 * <repo> is its repository's top level (requireRepo), possibly through a
 * symlink; the bundle goes next to the REAL top level, so never inside
 * the work tree, where it would sit as an untracked file (AC-70) -- not
 * even for `r/self -> .` -- and never away from the repository next to a
 * link (D21, AC-84). */
export function createBackupBundle(repo: string, env: NodeJS.ProcessEnv): string {
  const top = git.topLevel(repo);
  if (top === null || fs.realpathSync(top) !== fs.realpathSync(repo)) {
    throw new Error('createBackupBundle: ' + repo + ' is not the top level of its repository');
  }
  const absRepo = fs.realpathSync(top);
  const base = path.basename(absRepo);
  const dir = path.dirname(absRepo);
  const stamp = utcStamp(new Date());
  const bundlePath = path.join(dir, base + '.backup-' + stamp + '.bundle');
  git.text(repo, ['bundle', 'create', bundlePath, '--all'], { env });
  return bundlePath;
}
