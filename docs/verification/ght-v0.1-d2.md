# Verification: v0.1 final candidate (D2 delta)

Independent verification of the D2 delta on top of the GHT-3 candidate
(`docs/verification/ght-v0.1.md`, 33ae189). Contract: D2 (`a4e8b9f`) plus
the spec as of `4df8c04`/`6202166`. Implementation: `58931b4`. Claim:
40/40, 0 leftovers.

## 1. Diff review

**`tail --tag`** (`lib/squash.js` `cmdTail`): the tag-exists check
(`rev-parse --verify --quiet refs/tags/<tag>`) runs right after
`refuseOnMerge`, before `groupsFromTags`, before `createBackupBundle` --
i.e. before any write, for both dry run and `--apply` alike, matching
§ 1.3. The writing order is `createBackupBundle` -> `createSigner` ->
`commit-tree -S` -> `update-ref` -> (if `--tag`) `git tag -s`: the backup
bundle is the first write, confirmed by reading the code (not inferred).

Under `--dates=anon`, the tag is created with `GIT_COMMITTER_DATE` forced
to `whenC` (the same value used for the commit's own author/committer
date), so the tagger date is identical to the commit's date -- confirmed
live on nanojira (§ 4). Under `--dates=keep` the env is passed through
unchanged, so the tagger date is the real wall-clock time of the tag
operation, matching the spec text ("under `keep` it is the real time the
tag is created") rather than the commit's original date -- this is
correct per spec, not a bug (my first read suspected a mismatch; the
spec text at docs/SPECIFICATION.md:200-202 settles it). The signature
time comes from `signer.gitConfig` (the same `gpg.program` wrapper as
the commit), so it is pinned to key-creation+60s regardless of
`--dates`, as required.

Subject format `<name> <tag>: <title>` and tag-message-is-full-text are
exactly as coded; `<title>` is `tagMessageText.split('\n')[0]`.

**Dry-run-no-objects** (`lib/rewrite.js`): `mktree(..., write)` with
`write=false` builds the raw tree object by hand -- entries sorted by
`treeSortKey` (name, with a trailing `/` appended for `tree` entries,
matching git's own tree-entry sort, which treats directories as
`name/` for ordering purposes) and concatenated as
`mode(no leading zero) + ' ' + name + '\0' + rawShaBytes(20)`, hashed via
`git hash-object -t tree --stdin` (no `-w`). The mode-stripping regex
(`/^0+(?=\d)/`) turns `040000` into `40000` and leaves `100644`/`100755`/
`120000` untouched -- that is exactly git's canonical on-disk mode
encoding (tree mode has no leading zero; blob/symlink modes already
have none), confirmed by hand-computing one in § 1's mutation tests.
`hashObjectBlob(..., write=false)` drops `-w` the same way.
`computeRecords(write)` is called with `false` for the report path and
`true` only inside the `--apply` branch, and that branch's call sits
**after** `createBackupBundle`/`createSigner` -- the actual (writing)
tree/blob computation happens only once the backup bundle already
exists, per the new comment in the code and confirmed by reading the
diff. I did not find a case where the dry-run and `--apply` hashes could
diverge for the same input: both call the same `rewriteTreeWithRules`/
`setPathInTree`/`rewriteBlob` functions with only the `write` flag
differing, so the sha computed with `write=false` is definitionally the
sha that `git hash-object -w`/`mktree` would assign to the same bytes.
`history-rewrite`'s own `--hook` still runs (and may write) during a dry
run's tree computation, by design (§ 0): only the tool's own preview
work must not write, and it does not.

One (non-blocking) observation: `lib/rewrite.js`'s own `isDirty`
check and its call in `runRewrite` (present before `58931b4`) were
removed in this diff with no replacement. There is no spec requirement
or AC for a dirty-tree refusal on `history-rewrite` (checked
docs/SPECIFICATION.md and `test/ac/*rewrite*`; only `ght-squash` has
that rule, § 1.2/AC-06), and `history-rewrite` never touches the
working tree (it works entirely through plumbing), so removing dead,
unspecified code here is correct, not a regression.

## 2. Flakiness

Ran `test/run-all.js` 5 times in a row in the background
(`TMPDIR=/tmp GHT_TEST_ROOT=/tmp`, `set -euo pipefail` wrapper script
under `/tmp/ght6`, now removed). All 5 runs: 40 passed, 0 failed, 0
cannot-run. Did not reproduce the Oracle's one-time AC-40/AC-32 failure.
By inspection: the two candidate causes the Lead suggested do not look
load-bearing in this codebase as it stands -- (a) the backup-bundle
filename is `<repo-basename>.backup-<UTC-to-the-second>.bundle`, and
every AC uses a distinct repo basename (`ac09`, `ac15`, ...), so a
same-second collision would need the same basename twice in one
process, which does not happen; (b) hardcoded paths like
`/tmp/ac09-map.txt` are overwritten fresh by each run and nothing reads
stale content across runs. Most likely the one-time failure was a
transient system condition (e.g. clock-second boundary hit during a
single, unlucky run) rather than a reproducible defect; I could not
confirm a root cause with 5/5 green.

## 3. Mutations (worktree detached at `58931b4`, each reverted before the next)

| # | Mutation | Result |
|---|---|---|
| 1 | Tag's `GIT_COMMITTER_DATE` override removed (`tagEnv = env` unconditionally) | AC-36 red: tagger date `1791597209 +0200` (now) instead of the expected `129600 +0000` (commit's anon date) |
| 2 | Early tag-exists check removed; tag creation left to fail on git's own native check | AC-36 red: 2 checks fail -- the refusal message no longer contains `tag v1 already exists` (git's native message quotes the tag name differently), and `refs/heads/main` had already moved (commit-tree + update-ref ran before the native git-tag failure), so "nothing written" is false |
| 3 | `computeRecords(false)` (dry-run report path) changed to `computeRecords(true)` | AC-39 red: `git count-objects -v` changes (count 3->5, size 12->20) on an `add-file` dry run; AC-31 (refs-only check) stays green, confirming it alone would have missed this, same gap I flagged in GHT-3 |
| 4 | `createBackupBundle(repo, env)` in `cmdTail`'s `--apply` branch moved to run after `commit-tree`/`update-ref` instead of before | **Full suite still 40/40 green** -- no AC caught this. Gap, see below. |

**Gap found**: there is no AC asserting that `tail`'s backup bundle is
taken *before* its writes (the equivalent of AC-09, which only covers
`apply`). Moving the bundle to after the commit/ref write in `cmdTail`
produces a bundle that no longer captures the pre-release state --
defeating its purpose as a rollback snapshot for exactly the new
one-step release workflow D2 introduces -- yet the suite does not
notice. Recommend an AC-09-style bundle-content check for `tail`
(ideally also covering the `--tag` path specifically, since that is the
real release command going forward).

## 4. Dogfood: nanojira `tail --tag v9.9-test --message "test release" --name nanojira --apply`

Fresh clone of the real nanojira repo to `/tmp` (never written to
directly); the clone's local git config was given the real identity,
signing key, and `gpg.program` (the real repo's own
`.git/gpg-signer.sh`), so the tool signs with the real key inside the
disposable clone only. At the time of this run nanojira's HEAD was
`e54884c` (27 commits: 26 tagged release commits + 1 untagged tail),
so `groups.length` = 26 and the new commit's anon position is 26 ->
`anonDateAt(26) = 27*86400+43200 = 2376000`.

- New commit `2b77f90...`: author and committer date both `2376000
  +0000` = **1970-01-28 12:00:00 +0000**, as expected.
- Subject: **`nanojira v9.9-test: test release`**, exact match.
- `v9.9-test` is an annotated, signed tag; tagger date `2376000 +0000`,
  equal to the commit's date.
- `git verify-commit HEAD` and `git verify-tag v9.9-test`: both **good
  signature**, real key `680EDD20...`, real identity.
- `git show-ref`, diffed against a pre-run snapshot with `refs/heads/main`
  and `refs/tags/v9.9-test` excluded: **identical** -- every earlier ref
  (all prior tags, all prior commit hashes) unchanged.

## 5. Leak check

`bin/ght-scan scan .` against git-history-tools' own history (owner
identity via an outside `/tmp` allowlist file, as in GHT-3): only
already-known synthetic fixture strings from AC test files
(`*.invalid`/`*.example` domains, `jdoe@...`, etc.) and the
illustrative examples inside `docs/verification/ght-v0.1.md` itself
(unchanged from GHT-3). Separately diffed `4df8c04`, `58931b4`,
`6202166`, `a4e8b9f` individually against email/URL/local-path regexes:
the only match anywhere in the D2 commits is `jdoe@internal.example`,
the pre-existing AC-39 leak-scan test fixture. No new real leak
introduced by D2.

## Clean-up

Mutation worktree removed (`git worktree remove --force`); dogfood
clone, allowlist file, and all `/tmp/ght6` scratch files removed; the
test suite's own hardcoded-path fixtures (`/tmp/ac*-map.txt`,
`/tmp/ac*-rules.txt`, etc., written directly by individual AC files
outside the harness's own `TMP_ROOT`/`sweepBackupBundles` tracking --
pre-existing design, not a D2 regression) removed by hand after the 5
suite runs. `~/.gnupg` not touched. nanojira's real repo: untouched
(only its disposable `/tmp` clone was written to).

## Summary

**Verdict: PASS.** The D2 contract (`a4e8b9f`) is implemented correctly
in `58931b4`/`6202166`: `tail --tag` produces the expected subject, tag,
tagger date and pinned signature; refuses before any write when the tag
exists; dry runs for both `release-squash` and `history-rewrite` write
zero git objects, and the dry-run/`--apply` hash computation is provably
the same function with only a `write` flag differing. 40/40 ACs
confirmed; 5/5 suite runs green (one-time flakiness not reproduced);
3 of 4 required mutations turn the expected AC red, one does not -- a
genuine coverage gap (no bundle-before-write check for `tail`,
documented above, not blocking for v0.1 but worth a follow-up AC).
Dogfood against the real nanojira history matches every expectation
exactly. No new leaks in the D2 commits.

## Addendum (GHT-8): re-check against a5be69b

The Oracle's `a5be69b` (test-only) addresses the bundle-ordering gap
found above and moves every hardcoded `/tmp/acNN-*` fixture path into
`H.freshDir()`.

**1. Bundle-order mutation, applied separately to each of the four
writing paths** (`/tmp` worktree detached at `a5be69b`, each mutation
reverted before the next): moved `createBackupBundle(repo, env)` to run
after that path's own commit-tree/update-ref/tag writes instead of
before.

| Path | AC(s) turned red | Failure |
|---|---|---|
| `apply` | AC-09 | bundle's branch head and `v1` both show the post-apply shas instead of the pre-apply ones |
| `tail` (untagged) | AC-15 | bundle's branch head shows the post-tail sha |
| `tail --tag` | AC-36 | bundle's branch head shows the post-release sha; bundle now (wrongly) already carries `refs/tags/v1` |
| `history-rewrite` (`replace`) | AC-32 | bundle's branch head and `v1` both show the rewritten shas |

All four mutations caught; the gap from GHT-6 is closed.

**2. Test-diff review**: the new harness helpers
(`findBackupBundle`/`bundleListHeads`/`branchName`) compare a bundle's
*own* ref shas (via `git bundle list-heads`) against shas captured
*before* the write, not just whether a ref name is present in the
bundle -- a late bundle would still carry `refs/heads/<branch>` and
`refs/tags/v1`, just pointing at the rewritten targets, so presence
alone could not have caught the GHT-6 gap; sha equality can. Each of
AC-09/15/32/36 also asserts the relevant ref actually moved (`headAfter
!== headBefore`), so the sha comparison cannot pass by vacuous
coincidence (e.g. a no-op run). `H.freshDir()`-based scratch files
(map/rules/message files) are mkdtemp'd directories under `TMP_ROOT`,
tracked in `_tmpDirs`, outside any fixture repo -- still satisfying
§ 4.4's "rules file must lie outside the repo" (spot-checked on AC-29,
which exercises exactly that rule via a symlink).

**3. Two full suite runs**, each with `ls /tmp` captured immediately
before and after: both 40/40 green, and `diff` of the two listings
showed **zero new entries** either time.

**4. README.md (`06cc300`) quick-start**, run verbatim against a fresh
`/tmp` fixture repo (one commit, throwaway signing key for the
`--apply` line, generated the same way the test harness does):
- `sh bin/ght-scan scan <repo> --allow <outside-file>` -- exit 0.
- `sh bin/ght-squash tail <repo> --name=my-repo --tag=v1.0
  --message="first release"` (dry run) -- printed `tail: squashes 1
  commit(s) (...) into "my-repo v1.0: first release"` and the dry-run
  line, exit 0.
- Same command with `--apply` -- exit 0, `verify: tree delta: OK` /
  `verify: signatures: OK`; resulting commit subject is exactly
  `my-repo v1.0: first release`; `v1.0` signed and `git verify-tag`
  reports a good signature from the throwaway key.

All three commands match the real CLI exactly as documented. The
README's anonymous-date description ("commit *i* at 1970-01-(*i*+1)
12:00 UTC") also checks out against `anonDateAt` for 1-based *i*.

**Clean-up**: mutation worktree removed; the two `ls /tmp` snapshot
pairs, the README fixture repo, and its throwaway `GNUPGHOME` all
removed by hand afterward. `~/.gnupg` untouched; no shared-tree repo
written to.

**Verdict: PASS.** v0.1 final candidate confirmed at `a5be69b`.
