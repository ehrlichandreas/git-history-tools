/* § 4.1: the backup bundle, created before any ref is touched. */
import path from 'node:path';
import * as git from './git.ts';

function utcStamp(d: Date): string {
  const p = (n: number, w?: number) => String(n).padStart(w || 2, '0');
  return d.getUTCFullYear() + p(d.getUTCMonth() + 1) + p(d.getUTCDate()) +
    'T' + p(d.getUTCHours()) + p(d.getUTCMinutes()) + p(d.getUTCSeconds()) + 'Z';
}

/** Creates <parent-of-repo>/<repo-basename>.backup-<UTC>.bundle, --all,
 * capturing every ref as it stands right now. Returns the bundle path. */
export function createBackupBundle(repo: string, env: NodeJS.ProcessEnv): string {
  const absRepo = path.resolve(repo);
  const base = path.basename(absRepo);
  const dir = path.dirname(absRepo);
  const stamp = utcStamp(new Date());
  const bundlePath = path.join(dir, base + '.backup-' + stamp + '.bundle');
  git.text(repo, ['bundle', 'create', bundlePath, '--all'], { env });
  return bundlePath;
}
