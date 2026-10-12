/* § 4.2: shared post---apply verification checks, printed as
 * "verify: <check>: OK" / "verify: <check>: FAILED (<reason>)". */
import * as git from './git.ts';
import * as leakscan from './leakscan.ts';

export interface VerifyResult {
  ok: boolean;
  line: string;
}

export interface TreeCheck {
  label: string;
  expected: string;
  actual: string;
}

function line(name: string, ok: boolean, reason?: string): VerifyResult {
  return { ok, line: ok ? ('verify: ' + name + ': OK') : ('verify: ' + name + ': FAILED (' + reason + ')') };
}

/** checks: [{label, expected, actual}] -- every pair must be equal. */
export function verifyTreeDelta(checks: TreeCheck[]): VerifyResult {
  for (const c of checks) {
    if (c.expected !== c.actual) {
      return line('tree delta', false, c.label + ': expected tree ' + c.expected + ', got ' + c.actual);
    }
  }
  return line('tree delta', true);
}

/** Every commit and annotated tag reachable from any local branch or tag
 * has a signature git verify-commit/verify-tag accepts. Deliberately
 * --branches --tags, not --all: --all also walks refs/remotes/* (and
 * refs/stash, refs/notes), and a stale remote-tracking ref left pointing
 * at the pre-rewrite tip -- never touched by apply/tail/replace, which
 * only move refs/heads/* and refs/tags/* -- would otherwise still show up
 * as "reachable" and get verified, even though it is no longer part of
 * the history this write produced (and may predate the current signing
 * key entirely). */
export function verifySignatures(repo: string, env: NodeJS.ProcessEnv): VerifyResult {
  const commitsRaw = git.text(repo, ['rev-list', '--branches', '--tags'], { env });
  const commits = commitsRaw ? commitsRaw.split('\n') : [];
  for (const c of commits) {
    const r = git.run(repo, ['verify-commit', c], { env });
    if (r.status !== 0) return line('signatures', false, 'verify-commit ' + c.slice(0, 7) + ' failed: ' + (r.stderr as string).trim());
  }
  const tagsRaw = git.text(repo, ['for-each-ref', '--format=%(refname:short)\t%(objecttype)', 'refs/tags'], { env });
  const tags = tagsRaw ? tagsRaw.split('\n') : [];
  for (const l of tags) {
    const [name, type] = l.split('\t');
    if (type !== 'tag') continue;
    const r = git.run(repo, ['verify-tag', name], { env });
    if (r.status !== 0) return line('signatures', false, 'verify-tag ' + name + ' failed: ' + (r.stderr as string).trim());
  }
  return line('signatures', true);
}

/** git-release-squash `apply` only: every commit reachable from HEAD has at
 * least one tag pointing at it. */
export function verifyEveryCommitTagged(repo: string, env: NodeJS.ProcessEnv): VerifyResult {
  const commitsRaw = git.text(repo, ['rev-list', 'HEAD'], { env });
  const commits = new Set(commitsRaw ? commitsRaw.split('\n') : []);
  const tagsRaw = git.text(repo, ['for-each-ref', '--format=%(*objectname)\t%(objectname)', 'refs/tags'], { env });
  const taggedCommits = new Set<string>();
  for (const l of (tagsRaw ? tagsRaw.split('\n') : [])) {
    const [deref, obj] = l.split('\t');
    taggedCommits.add(deref || obj);
  }
  for (const c of commits) {
    if (!taggedCommits.has(c)) return line('squash: every commit tagged', false, c.slice(0, 7) + ' is not tagged');
  }
  return line('squash: every commit tagged', true);
}

/** git-history-rewrite `replace` only: a git-leak-scan (built-in categories, no
 * terms/allow) of the right-hand replacement values finds 0 hits. */
export function verifyRuleSourcesClean(replacementValues: string[]): VerifyResult {
  const found: string[] = [];
  for (const v of replacementValues) {
    for (const hit of leakscan.scanBuiltins(v)) found.push(hit.match);
  }
  if (found.length === 0) return line('replace: rule sources clean', true);
  return line('replace: rule sources clean', false, 'replacement value(s) leak: ' + found.join(', '));
}
