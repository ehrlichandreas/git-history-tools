/* D21 (Scout N1): ght rewrites UTF-8 objects only. Messages, authors and
 * taggers pass through JavaScript strings on the way to the new object,
 * so bytes that are not UTF-8 came out as U+FFFD, and a commit's
 * `encoding` header was dropped -- and the result was re-signed. Until
 * there is a byte-preserving path, every object a run would rewrite or
 * re-sign is checked first, and one that is not UTF-8 is a usage error
 * before anything is written (AC-95). */
import * as git from './git.ts';
import { UsageError } from './cli.ts';

type Env = NodeJS.ProcessEnv;

export interface Checked {
  sha: string;
  /** How the refusal names it: `tag v1`, `commit 1a2b3c4`. */
  label: string;
}

const UTF8 = new TextDecoder('utf-8', { fatal: true });

/** Why `raw` (a commit or tag object) is not UTF-8, or null when it is. */
function nonUtf8Reason(raw: Buffer): string | null {
  const end = raw.indexOf('\n\n');
  const head = (end === -1 ? raw : raw.subarray(0, end)).toString('latin1');
  const m = /^encoding (.*)$/m.exec(head);
  if (m && !/^utf-?8$/i.test(m[1].trim())) return 'encoding ' + m[1].trim();
  try {
    UTF8.decode(raw);
  } catch {
    return 'bytes that are not valid UTF-8 in its message or identity';
  }
  return null;
}

/** Refuses (exit 2) at the first of `objects` that is not UTF-8. One
 * `cat-file --batch` for all of them. */
export function refuseNonUtf8(repo: string, env: Env, objects: Checked[]): void {
  const seen = new Set<string>();
  const list = objects.filter((o) => !seen.has(o.sha) && seen.add(o.sha));
  if (list.length === 0) return;
  const out = git.buffer(repo, ['cat-file', '--batch'], { env, input: list.map((o) => o.sha).join('\n') + '\n' });
  let pos = 0;
  for (const o of list) {
    const nl = out.indexOf(0x0a, pos);
    const size = Number(out.subarray(pos, nl).toString('latin1').split(' ')[2]);
    const why = nonUtf8Reason(out.subarray(nl + 1, nl + 1 + size));
    if (why) throw new UsageError(o.label + ' is not UTF-8 (' + why + '); ght rewrites UTF-8 objects only, nothing written');
    pos = nl + 1 + size + 1;
  }
}
