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

/** A planned branch tip: `ref` (full `refs/heads/<name>`) and the commit
 * sha it will have once the pending ref transaction lands -- the CURRENT
 * sha for a branch the run never touches. */
export interface PlannedHead {
  ref: string;
  sha: string;
}

/** A planned tag: `ref` (full `refs/tags/<name>`), `type` ('tag' for
 * annotated, anything else for lightweight), the commit it will point at
 * (`commit`) and, for an annotated tag, the tag object's own sha
 * (`tagObj`, equal to `commit` for a lightweight tag) -- again the
 * CURRENT values for a tag the run never touches. */
export interface PlannedTag {
  ref: string;
  type: string;
  commit: string;
  tagObj: string;
}

/** Every commit and annotated tag reachable from any local branch or tag
 * has a signature git verify-commit/verify-tag accepts -- against `heads`
 * and `tags`, the full PLANNED final state of every `refs/heads/*` and
 * `refs/tags/*` ref (D24, Q2 follow-up): the new value for every ref the
 * caller's own ref transaction is about to write, and the CURRENT value,
 * read before anything else, for every other branch/tag it leaves alone.
 * Takes explicit shas throughout (`rev-list <sha>...`, `verify-tag
 * <tag-object-sha>`), never `--branches`/`--tags`/a ref name, so it needs
 * no ref to exist yet and can run entirely before the transaction: an
 * unrelated branch's own unsigned commit still fails this exactly as it
 * always did (the check covers the whole repo, not just the one ref this
 * run moves), just before any ref moves rather than after. Deliberately
 * excludes `refs/remotes/*` (and `refs/stash`, `refs/notes`), same as the
 * original live-ref version: a stale remote-tracking ref -- never touched
 * by apply/tail/replace/add-file, which only move refs/heads/* and
 * refs/tags/* -- would otherwise still show up as "reachable" and get
 * verified, even though it is no longer part of the history this write
 * produced (and may predate the current signing key entirely). */
export function verifySignatures(repo: string, env: NodeJS.ProcessEnv, heads: PlannedHead[], tags: PlannedTag[]): VerifyResult {
  const tips = heads.map((h) => h.sha).concat(tags.map((t) => t.commit));
  const commitsRaw = tips.length ? git.text(repo, ['rev-list'].concat(tips), { env }) : '';
  const commits = commitsRaw ? commitsRaw.split('\n') : [];
  for (const c of commits) {
    const r = git.run(repo, ['verify-commit', c], { env });
    if (r.status !== 0) return line('signatures', false, 'verify-commit ' + c.slice(0, 7) + ' failed: ' + (r.stderr as string).trim());
  }
  for (const t of tags) {
    if (t.type !== 'tag') continue;
    const r = git.run(repo, ['verify-tag', t.tagObj], { env });
    if (r.status !== 0) return line('signatures', false, 'verify-tag ' + git.refBase(t.ref, 'refs/tags/') + ' failed: ' + (r.stderr as string).trim());
  }
  return line('signatures', true);
}

/** git-release-squash `apply` only: every commit reachable from the
 * PLANNED new HEAD (`headSha`, the commit the pending transaction is
 * about to point the branch at) has at least one tag in the PLANNED
 * `tags` list pointing at it (D24, Q2 follow-up) -- same ref-independence
 * as `verifySignatures` above, for the same reason. */
export function verifyEveryCommitTagged(repo: string, env: NodeJS.ProcessEnv, headSha: string, tags: PlannedTag[]): VerifyResult {
  const commitsRaw = git.text(repo, ['rev-list', headSha], { env });
  const commits = new Set(commitsRaw ? commitsRaw.split('\n') : []);
  const taggedCommits = new Set(tags.map((t) => t.commit));
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
