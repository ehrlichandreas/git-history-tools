# Verification — git-history-tools v0.1 (33ae189)

Independent check of 97d0495 (implementation) + f92e7a1 (AC-35 adoption) +
33ae189 (SPECIFICATION §2.1 addendum, tests unchanged), against
docs/DECISIONS.md D1 (incl. bd16ac2) and docs/SPECIFICATION.md.

**Verdict: PASS.** 35/35 AC files green at 33ae189 (confirmed independently).
No correctness defects found. Two non-blocking observations below (§5, §6).

## 1. Diff review (lib/, bin/, SKILL.md vs. spec)

Read lib/cli.js, git.js, bundle.js, signer.js, verify.js, leakscan.js,
scan.js, squash.js, rewrite.js (2226 lines total) end to end against every
numbered spec clause, plus the three `bin/*` wrappers and SKILL.md.

- **Refusal paths**: usage errors (exit 2) vs. refusals (exit 1) are
  cleanly separated via `UsageError`/`Refusal` classes and `cli.js`'s
  `main()` dispatcher (§0). Merge-commit, dirty-tree, untagged-HEAD,
  detached-HEAD, and rules/terms/allow-inside-repo refusals all match
  the spec's exact message shape and fire before any write (confirmed
  live and by mutation, §3 below).
- **Dry-run default**: `release-squash apply`/`tail` compute their report
  without calling `commit-tree` at all when `--apply` is absent (the
  early-return happens before any git write call) — a true no-op.
  `history-rewrite replace`/`add-file` are different: `runRewrite()`
  unconditionally computes `records` (via `transformTree`) **before**
  branching on `--apply`, and `transformTree` calls `git hash-object -w`
  / `git mktree` to get real shas for the "would change" report. This
  writes loose, unreferenced objects into `.git/objects` even during a
  dry run. Spec §0 only promises a dry run "changes no ref... creates no
  bundle" — it does not promise no object is written, unlike the refusal
  clause which explicitly says "no object written" (§0, refusal
  paragraph). So this is spec-compliant as literally written, and
  AC-08/AC-31 (which check `git show-ref` before/after) pass — but it is
  a real asymmetry between `squash`'s dry run (writes nothing at all) and
  `rewrite`'s dry run (writes orphaned objects, never referenced, GC'able,
  never pushed). Confirmed live: `.git/objects` count increases across a
  `replace` dry run; `show-ref` output is byte-identical before/after.
  Worth a footnote in the spec if this surprises a future reader; not a
  defect.
- **Backup bundle** (§4.1): `createBackupBundle` runs `git bundle create
  <parent>/<basename>.backup-<UTC>.bundle --all` before any ref write, in
  both `squash` (`apply`/`tail`) and `rewrite` (`replace`/`add-file`).
  Confirmed via mutation (§3) that AC-09 catches a dropped call.
- **Signature time**: `signer.js`'s `createSigner()` reads
  `user.signingkey` and `gpg.program` from the target repo's own config
  (never hard-coded), reads the key's real creation time via
  `gpg --list-keys --with-colons` (field 6 of the `pub:` line), and signs
  at `created + 60`, via a per-run `mkdtemp`'d wrapper script invoking
  `gpg --faked-system-time <t>!`. It never sets `GNUPGHOME` itself — the
  caller's own environment governs the keyring. Matches D1 exactly
  ("signature time is the key's creation time + 60s").
- **Lightweight tags stay lightweight under `tag.gpgsign=true`**:
  `cmdApply`'s re-tagging loop branches on `t.type === 'tag'` (annotated)
  vs. the `else` (lightweight, `update-ref` only, never `git tag`) — so a
  repo-wide `tag.gpgsign=true` never upgrades a lightweight tag, since
  `update-ref` doesn't consult that config at all. Confirmed live (AC-03)
  and by mutation (§3: forcing the annotated branch unconditionally turns
  AC-03 red with an exact, readable failure).
- **Binary blobs**: `leakscan.isBinary`'s NUL-within-8000-bytes check
  gates both `rewrite.js`'s `rewriteBlob` (binary → sha passed through
  unchanged, rule application skipped entirely) and `scan.js`'s per-blob
  dispatch (binary → `scanPemInBuffer` only, built-in text categories and
  `--terms` skipped, but the PEM header check still runs against raw
  bytes as latin1 — so a binary-encoded key is still caught, per spec).
  AC-25 is green and I did not find a path that re-encodes a binary blob.
- **Leak-scan exit codes and allowlist**: `cmdScan` aggregates hits by
  `(category, match)`, deduplicating by `(category, match, commit, path)`
  — which correctly implements the spec's "distinct (commit, path) pairs"
  counting semantics (verified by reading the dedup-key construction, not
  just trusting AC-18). Allowlist (`--allow`) is applied at print time by
  exact string match against `e.match`, after aggregation — so an
  allowlisted match is fully suppressed from both output and the exit
  code, as required. Exit 0/1/2 mapping is exactly as specified.

## 2. Leak check

- `bin/ght-scan scan .` against git-history-tools' own repo (with
  `ehrlich.andreas@googlemail.com` allowlisted) returns only synthetic,
  clearly-fake fixture data from the test suite itself (`jdoe@internal.
  example`, `asmith@internal.example`, `build01.corp.example`,
  `203.0.113.7`, `ght-test@example.invalid`, PEM/token fixtures) — all
  `.example`/`.invalid`-domain or otherwise obviously synthetic, zero real
  personal data, hostnames, or keys. One minor regex observation: the
  URL pattern (`[^\s)"'`>\]]+`) does not exclude a literal backslash, so
  a URL immediately followed by a JS-source-level `\n` (two literal
  characters, not a newline — as found in one AC fixture's own source
  text) is captured as a second, slightly-longer match variant alongside
  the clean one. Harmless (both variants are the same synthetic fixture
  string, not a real leak) but noted as a possible future over-capture
  in unusual adjacency cases.
- My own independent scan (separate from `ght-scan`) of git-history-tools'
  reachable blobs/messages/identities for real names, work email/domain,
  other project names, AI vendor/model names, API-key-shaped tokens, and
  hostnames: zero hits beyond the already-allowlisted owner identity.

## 3. Mutation tests (`/tmp/ght-mut`, detached worktree at 33ae189, never the shared tree)

All five mutations were applied one at a time, tested, then reverted
(`git checkout --`) before the next:

| Mutation | AC(s) turned red | Result |
|---|---|---|
| `anonDateAt`: 0-based instead of 1-based | AC-11 | 6/8 checks failed, exact wrong-date diffs shown |
| Drop `createBackupBundle()` call in `apply --apply` | AC-09 | 1/3 failed: "exactly one backup bundle... appears" |
| Force lightweight tags through the annotated-tag branch | AC-03 | 1/14 failed: "v1 is STILL lightweight... expected commit, got tag" |
| Disable `refuseMessageChange` in `replace` | AC-27, AC-28 | AC-27: 4/5 failed (wrong exit code, ref not preserved); AC-28: 2/3 failed |
| Disable the allowlist check in `scan` | AC-22 | 2/5 failed: allowlisted email reappears, exit 1 instead of 0 |

No mutation survived — every one produced a clear, readable red. No
coverage gap found.

## 4. Real-world dogfood (`/tmp` clones of nanojira only; real repo never written to)

- **`ght-squash plan`** against a fresh clone of nanojira's real history
  (HEAD `e54884c`, 26 originally-tagged commits + 1 untagged commit,
  since the Lead's UNFREEZE/squash-tail policy means main now always
  carries an untagged tail between releases): all 26 existing tag groups
  report `tree equals ...: OK`, zero mismatches; the one real untagged
  commit (`e54884c`) is correctly reported as the untagged tail. (The
  task's original "26 commits, all tagged, nothing to squash" framing
  predates `e54884c` landing on nanojira's main during this same
  session; adapted the check to the live state rather than a stale
  assumption.) One genuine plan-output edge case surfaced live and
  confirmed **not** a bug: nanojira has several single-commit groups
  carrying two co-located tags (e.g. `c4-baseline`+`oracle-frozen-9`).
  Per spec §1.1's own stated convention ("the first tag carries the
  group's real fold count; every additional co-located tag is 'just this
  commit' (N=1)"), when the group is exactly one commit with two tags,
  the first tag's own line reads `folds 0 commit(s)` — correct under the
  literal rule, but AC-02's own fixture (2 commits, 2 co-located tags)
  never exercises the `group-size == tag-count` boundary. Recommend an
  AC for this exact edge case; not a spec or implementation defect.
- **`ght-squash tail --apply`**: added two plain commits to the clone,
  tagged the first `v9.9-test` (signed, using the real signer config —
  `user.signingkey`/`gpg.program` copied from the real nanojira repo's
  local config into the clone; `GNUPGHOME` pointed at the real
  `~/.gnupg`, read-only, exactly as authorized), leaving the second
  commit as the untagged tail. `tail --apply` squashed it cleanly:
  `verify: tree delta: OK`, `verify: signatures: OK`, exit 0. Confirmed:
  the new commit's tree is byte-identical to the original tail commit's
  tree; `git verify-commit` on the new HEAD shows "Good signature from
  Andreas Ehrlich..." against the real key; every earlier commit/tag
  (`v3.12.1`, `v3.3`, `v3.10`, `v3.12`, and the two newly-added, still
  untouched originals) kept its exact original sha, confirmed by diffing
  against the real repo. One discrepancy from the task's own prediction:
  the new commit landed at **1970-01-29** 12:00:00, not the predicted
  1970-01-28. Working the formula by hand: at `tail` time there were 26
  original nanojira groups + the new `v9.9-test` group = 27 existing
  groups, so `position = groups.length = 27`, and `anonDateAt(27) =
  (27+1)*86400+43200` lands on day 28 (0-based from epoch) = 1970-01-29.
  This matches AC-11/AC-35's own tested 1-based-`i`, root-is-day-2
  convention exactly (independently re-derived and cross-checked against
  the mutation-tested formula in §3) — I'm confident the tool is
  internally consistent and spec-correct here; the task's "01-28"
  prediction looks like a one-day slip in the write-up (possibly an
  artifact of nanojira's history moving by one commit between when the
  task was written and when I ran it), not a defect to chase in the code.
- **`ght-scan` allow/leak round-trip**: against nanojira's real history,
  an allowlist containing only the owner's identity does **not** reach
  exit 0 — the real history (148 distinct hits) contains many legitimate,
  already-non-sensitive matches (npm registry URLs in `package-lock.json`,
  and several already-scrubbed placeholder values from the earlier D192
  pass: `dev@example.com`, `host.local`, `/home/dev/...`). None of the
  148 are real leaks on inspection; achieving exit 0 against this repo
  would require a larger allowlist, not a single entry — the task's
  framing of this sub-check didn't anticipate how much legitimate
  placeholder/registry content nanojira's real history already contains.
  To directly demonstrate the literal allow→0 / leak→1 contract without
  that noise, I built a small two-commit fixture repo (signed with the
  same real identity/key) and confirmed: `--allow` containing only the
  owner's email → exit 0; adding one synthetic leak (`jdoe@secretcorp.
  example`) → exit 1, hit reported correctly with commit:path.

## 5. Coverage gap found (test-suite hygiene, not a tool defect)

The test harness's own `cleanup()` (test/lib/harness.js) only removes
`_tmpDirs` (the `freshDir()`-created fixture roots). `createBackupBundle`
writes its bundle as a **sibling** of the repo directory (one level up —
for a `freshDir()`-created repo, that's directly in `TMP_ROOT`/`/tmp`
itself), so it is never tracked for cleanup. Every AC test that exercises
`--apply` leaves a permanent `.backup-<UTC>.bundle` file in `/tmp`
indefinitely. Confirmed by counting: **192 such stray bundle files already
present in `/tmp`** before I ran anything myself, accumulated purely from
this suite's own prior runs (not from my mutation/dogfood work, which I
verified leaves 0 of my own leftovers). This doesn't affect any AC's
correctness (none of them assert on `/tmp`'s overall contents, only on
the bundle's own existence/name/cleanliness), but it means the suite does
not itself satisfy a "0 leftovers in /tmp" bar on repeated runs. Worth a
follow-up: have `cleanup()` also sweep bundles matching the fixture
label, or write bundles under a tracked temp dir in test mode.

## 6. Clean-up confirmation

- `~/.gnupg` mtimes checked before and after the full run-all + mutation
  + dogfood session: zero files touched. All AC-suite signing uses a
  freshly generated, throwaway per-test `GNUPGHOME`; my own dogfood work
  used the real `GNUPGHOME` for signing (as explicitly authorized, since
  it mirrors what a real release does) but only ever *read* keys/config
  — no `--gen-key`, `--import`, or trustdb write of any kind.
  Independently confirmed via `find ~/.gnupg -newer ...`: empty.
  - 5 mutations applied and reverted in a detached `/tmp` worktree, removed afterward (`git worktree remove --force`).
  - All of my own dogfood/scan scratch directories under `/tmp` removed
    after use; confirmed via shell glob returning "no matches" for every
    pattern I created. The 192 pre-existing stray bundles and assorted
    `ght-ac*`/`ght-dbgac*` directories from the test suite's own prior
    runs (§5) were left in place — they predate this session and are a
    test-harness hygiene matter, not something I created or that this
    task asked me to bulk-delete.

## Summary

PASS. 35/35 ACs green, confirmed independently with `TMPDIR=/tmp`. Diff
matches spec in every checked particular; the one asymmetry found
(rewrite's dry run writes orphaned objects) is spec-compliant as written,
not a defect. Five mutations, five clean catches, no coverage gap in the
mutated behaviors. Dogfooded successfully against nanojira's real,
signed history with the real signing key, read-only on the real repo
throughout. One real coverage/hygiene gap identified (§5, stray backup
bundles never cleaned up by the test harness) and one likely one-day slip
in the task's own date prediction (§4), neither of which changes the
verdict.
