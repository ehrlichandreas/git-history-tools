# Decisions

## D1: Scope and shape (v0.1)

git-history-tools is a skill folder with three tools for preparing a git
history for publication. All three keep commits signed, and none of them
pushes.

**git-release-squash**
- `plan <repo>`: dry run. It prints which commits fold into which tag, the
  new subjects, and the tree-equality check per tag. It changes no refs.
- `apply <repo> --map <file>`: writes the squashed history. It makes a
  backup bundle first and writes `<old-sha> <tag>` lines to the map file.
- `tail <repo>`: squashes only the untagged commits since the last tag (the
  per-release step).
- The subject format defaults to `<name> <tag>: <title>`.
- Dates are `anon` by default, with commit i at 1970-01-(i+1) 12:00:00
  +0000 and tags on their commit's date. `keep` leaves dates as they are.
  - i is 1-based, oldest first. The root commit therefore gets
    1970-01-02 12:00:00 +0000, which matches the existing nanojira history
    (`@<i*86400+43200> +0000`).
  - `tail` keeps every existing commit's date unchanged. Each new commit
    gets the date for its position in the resulting history, so a history
    squashed earlier and then extended with `tail` is identical to one
    squashed in a single run.
- The signing key comes from the repo's git config. The signature time is
  the key's creation time + 60 s, read from gpg, via
  `--faked-system-time`.
- It refuses merges, a dirty tree and an untagged HEAD.

**git-leak-scan**
- `scan <repo> [--terms <file>]` searches every reachable blob, every
  commit and tag message, and every author/committer/tagger line.
- Built-in categories are emails, URLs, local home paths, hostnames, IPs,
  and secrets/private keys. The terms file adds the user's own
  case-insensitive terms, one per line.
- Output is one line per hit: category, match, count, and first
  commit:path.
- Exit status is 0 when clean, 1 on hits and 2 on usage errors.
- An allowlist file (`--allow <file>`) suppresses known-good matches.

**git-history-rewrite**
- `replace <repo> --rules <file>` applies ordered literal replacements to
  every text blob in every commit (`from<TAB>to` per line). It refuses if
  a commit or tag message would change.
- `add-file <repo> <path> [--as <repo-path>]` puts the file into every
  commit's tree.
- `--hook <script>` is optional. It runs per rewritten root tree for
  project-specific derived files (for example a checksum that covers a
  rewritten file) and receives the tree sha. It prints a replacement tree
  sha or nothing.
- Messages, dates and tag names are kept. Tags are re-signed with their
  commit's date.

**Shared rules**
- Every writing command runs as a dry run unless `--apply` is given.
- `--apply` creates `<repo>.backup-<UTC>.bundle` next to the repo first.
- After writing, the tool verifies four things:
  - only the expected tree delta;
  - all commits and annotated tags carry a good signature;
  - with squash, every commit is tagged;
  - with replace, a git-leak-scan of the rule sources finds 0 hits.
- Rules and terms files live outside the repo and are never committed.
  The tools warn if the file sits inside the target repo.
- Node.js ≥ 18 with no dependencies. The layout is `SKILL.md`, `bin/`
  (sh wrappers) and `lib/`.
- Tests build fixture repos under `/tmp` with a throwaway GNUPGHOME and a
  generated key. The user's keyring is never touched by tests, nor are the
  user's git config and git-sign policy: the harness sets
  `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_NOSYSTEM=1` and an empty
  `XDG_CONFIG_HOME` of its own (AC-66).
- Not in scope:
  - merge histories;
  - rewriting messages;
  - pushing;
  - nanojira's corpus splice, which belongs to nanojira as a `--hook`.

**This repo's own history** follows the same model: only tagged release
commits with anonymous dates. The first release squashes its working
commits using git-release-squash itself.

## D2: release step in one command; dry runs write nothing (v0.1)

From the GHT-3 verification and the Lead's dogfood run on a nanojira clone.

**`tail --tag <tag> --message <file|text>`.** The release step has to
produce a finished, anonymous release commit. A manual `git tag -s`
afterwards would carry the real tagger date and the real signature time.
With `--tag`, `tail`:
- writes the commit subject `<name> <tag>: <title>`, where `<title>` is the
  first line of the message;
- creates an annotated, signed tag `<tag>` on the new commit. The tag
  message is the given message, the tagger date follows `--dates`, so with
  anon it is the same instant as the commit, and the signature time is
  pinned the same way as for commits;
- refuses if `<tag>` already exists.

Without `--tag`, the current `(untagged)` behaviour stays, for staging.

**Dry runs write no git objects either.** That applies to every
subcommand, including `git-history-rewrite`. Hashes for the report are
computed without `-w`, and trees with `mktree --missing`. A dry run leaves
`.git/objects` byte-identical.

**Test hygiene.**
- The test harness removes the backup bundles it causes; they sit next to
  the fixture repo, outside the tracked temp dirs.
- A repeat run of the suite leaves 0 files in the tmp root.
- A new AC pins plan/apply output for a single-commit group that carries
  two tags.

## D3: two bug fixes (v0.3.1)

**`resolveOutsideFile()`'s containment check was one symlink short.** It
resolved symlinks in the given path's *parent* directory, but never the
path's own final segment. That catches a symlink living inside the repo
pointing out (the symlink itself would get committed), but missed the
opposite case: a `--rules`/`--terms`/`--allow` symlink living *outside* the
repo whose target resolves *inside* it was wrongly accepted. Fixed by also
fully resolving the given path (following every symlink, including the
final segment) and refusing if *either* resolution lands inside the repo —
both checks run now, neither replaces the other.

**`createBackupBundle()` didn't resolve `<repo>` to an absolute path before
taking its `basename`/`dirname`.** For `<repo>` given as `.` (normal once
already `cd`'d into the repo), `path.dirname('.')` is `.` itself, so the
backup bundle landed inside the repo's own working tree instead of next to
it — defeating the bundle's purpose (it must survive even a broken repo)
and leaving a stray file behind. Fixed by resolving `<repo>` with
`path.resolve()` first. The bug is specifically about a *relative* `<repo>`
with nothing for `dirname`/`basename` to recover an absolute parent from —
a trailing slash or an embedded `..` don't trigger it on their own, since
once a path is absolute, `path.dirname`/`path.basename` already strip a
trailing slash and `path.join`'s normalize already cancels a redundant
`..`, both before this fix existed.

## D4: `verifySignatures()` walked the wrong refs (found live, dogfooding)

`verifySignatures()` checked every commit from `git rev-list --all`, which
also walks `refs/remotes/*` (and `refs/stash`, `refs/notes`) — not just the
`refs/heads/*`/`refs/tags/*` that `apply`/`tail`/`replace`/`add-file`
actually write to. A real clone that still has a remote-tracking ref
pointing at the pre-rewrite tip (normal: these tools never fetch or push)
made that old, now-superseded commit still count as "reachable" and get
checked — even though it isn't part of the history this write produced,
and may be signed with an entirely different (possibly unknown-to-this-
keyring) key than the one actually used for the rewrite. The `tree delta`
check was unaffected (it only compares specific tree shas it already
recorded, not something it walks refs to find).

No existing AC caught this because every fixture repo is a bare `git init`
with no remote, so `--all` and `--branches --tags` agreed by construction.
Fixed by checking `git rev-list --branches --tags` instead of `--all`.

## D5: `allRefCommitsTopoReverse()` had the same `--all` bug (found in review of D4)

`git-history-rewrite`'s `allRefCommitsTopoReverse()` (shared by `replace`
and `add-file`) built its commit list the same wrong way as D4's
`verifySignatures()`: `git rev-list --all`, while `refTips()` -- what
`runRewrite()` actually re-points afterward -- only ever reads
`refs/heads`/`refs/tags`. Here the impact is worse than wasted work:

- `replace` loops over every commit from that list checking
  `refuseMessageChange` *before* `refTips()` is even consulted, so a stale
  `refs/remotes/origin/<branch>` pointing at a commit whose message happens
  to match a rule makes `replace` refuse with "commit `<sha>` message would
  change" on a branch whose own history has no such commit at all -- a
  false-positive refusal blocking a legitimate `replace`.
- `--hook` (§ 3.1, "may write") runs against trees for these stale-only
  commits too -- unwanted side effects, not just CPU waste, on commits the
  user never intended to touch.
- The extra, never-re-pointed-to rewritten objects for those commits are
  separately harmless: topo-order and the resulting shas for the commits
  that *are* actually re-pointed are unaffected by unrelated commits also
  being in the list; the extra objects are just unreferenced garbage,
  eventually GC'd.

Fixed the same way as D4: `rev-list --all` → `rev-list --branches --tags`.

## D6: `bin/*` wrappers didn't follow symlinks (found consuming this repo as an npm devDependency)

All three `bin/*` wrappers took `$(dirname "$0")` at face value to locate
`../lib/*.ts`. That works when run directly (`./bin/git-release-squash`),
but breaks the moment this package is installed as a dependency: npm
creates `node_modules/.bin/<name>` as a *symlink* to the real
`bin/<name>` inside this package, and POSIX `dirname "$0"` does not follow
symlinks — `$0` stays the literal `node_modules/.bin/<name>` path, so
`../lib/<name>.ts` resolved to `node_modules/lib/<name>.ts` (one level too
shallow, and missing the `git-history-tools/` segment entirely), and
every invocation through `npx`/`node_modules/.bin` failed with
`Cannot find module`.

Fixed by resolving `$0` through its symlink chain first (the standard
POSIX `while [ -h "$SOURCE" ]; do ...; done` idiom — works with both GNU
and BSD/macOS `readlink`, unlike GNU-only `readlink -f`) before taking
`dirname` and building the `../lib/*.ts` path.

This fix is correct and still stands for the case it targets: running
`bin/*` directly from a checkout that itself sits behind a symlink. It does
**not**, on its own, make `npx git-release-squash` (or the other two) work
once this package is actually installed as a dependency — see D7, found by
Reviewer while checking this fix.

## D7: compiled `lib/*.ts` even once `bin/*` resolves it correctly (found by Reviewer, reviewing D6)

D6 fixed `bin/*`'s symlink-following, but Reviewer found that fix alone
does not resolve the scenario it was meant for. Once `$0` resolves to the
real, installed `lib/<name>.ts`, Node refuses to run it anyway:

```
Error [ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING]: Stripping types is
currently unsupported for files under node_modules, for ".../node_modules/
git-history-tools/lib/squash.ts"
```

Node's native TypeScript type-stripping unconditionally refuses any `.ts`
file whose *resolved* path contains the literal string `node_modules`
anywhere in it. This is a hard platform restriction, not a bug, and no flag
works around it (not `--experimental-strip-types`, not
`--experimental-transform-types`): Node assumes an installed dependency
ships compiled JS, the same assumption this project's own consumer
(nanojira) relies on for its shipped `dist/*.mjs`. A raw `.ts` file can
therefore never be the runtime entry point for an npm-installed dependency
— only a compiled `.js`/`.mjs` works.

Fixed by giving this package a build step for its installable surface,
mirroring nanojira's own `tools/bundle.ts`: `tools/bundle.ts` bundles each
of `lib/squash.ts`, `lib/scan.ts` and `lib/rewrite.ts` (and everything they
import from `lib/`) with esbuild into one self-contained ESM file each —
`dist/squash.mjs`, `dist/scan.mjs`, `dist/rewrite.mjs` — enforcing, the same
way nanojira's bundler does, that the bundle imports nothing but Node
built-ins. `package.json`'s `"bin"` entries now point straight at these
compiled files instead of at `bin/*`, so npm's own `node_modules/.bin/<name>`
symlink lands on a `.mjs` that never needs type-stripping at all.

`bin/git-release-squash` etc. are untouched and still exec the raw
`lib/*.ts` directly — they are no longer reached through npm's `"bin"`
mechanism, but they are still what direct-checkout/local invocation and
every `test/ac/*.ts` use (via `test/lib/harness.ts`'s `runBin()`), so
running this project's own test suite never requires a build step first.
`tools/bundle.ts --check` (wired as `npm run build:check`, not into `npm
test`) builds everything in memory and fails unless `dist/*.mjs` is already
byte-identical to a fresh build and executable — a staleness check for
whoever commits a `lib/*.ts` change to also run `npm run build`, not a gate
in front of the test suite itself.

A symlink test outside `node_modules` (D6's own regression coverage) has
the same blind spot that let this ship once already: AC-41 instead builds
an actual `node_modules`-shaped fixture (a fake package directory whose
path literally contains `node_modules`, plus a real `.bin`-style symlink
into its `dist/`) and runs a tool through it end to end.

## D8: git-sign (v0.4) — never persist identity/key to repo config; signature time leaks working hours

**The trigger.** Reviewing nanojira's published history for a client
handoff, the Lead found that signature creation time and commit date can
disagree, and that disagreement leaks exactly the kind of fact an
anonymised history is supposed to hide. nanojira commit `c8d5657`'s commit
date is Thu 21:15 (plausibly outside working hours); its signature's own
creation time (`gpg --list-packets` on the `gpgsig` packet) is Thu 14:17 —
squarely inside a typical workday. D1's signer already pins every
signature to `created + 60s` specifically so a signature can never predate
its own key, but nothing before this enforced any relationship between a
signature's creation time and *working hours*, because nothing checked the
signature's own timestamp against anything at all — only the commit's. A
reviewer (or anyone with the signing key's public half) diffing commit date
against signature time learns when the committer was actually at a
keyboard, independent of whatever date the commit claims.

**The fix is a fourth tool, not a flag on the existing three.**
git-release-squash/git-leak-scan/git-history-rewrite all operate on
*existing* history; the leak above happens at the moment a commit or tag is
first *created*, before any of those three ever sees it, and re-signing
after the fact (`resign-tags`, below) cannot fix a date that was already
real. git-sign owns that moment going forward, plus a `check` to catch a
violation before it is ever pushed, plus `resign-tags` for the one thing
that genuinely can be fixed after the fact (a signature's timestamp, since
the signature is regenerable and carries no content of its own beyond
*when it was made*) — re-signing existing *commits* to fix an
already-published leaked signature time is out of scope here (the Lead
raises that separately with the user: it is a history rewrite of published
`main`, not something to do silently as a side effect of adding a new
tool).

**No persisted repo config, unlike D1.** D1's signer reads
`user.signingkey` from `<repo>`'s own git config, and the existing three
tools still do. git-sign deliberately does not: identity and key live in a
**policy file** outside the repo (reusing § 4.4's rule, same as
`--rules`/`--terms`/`--allow`), passed to git only as
`GIT_AUTHOR_*`/`GIT_COMMITTER_*` env vars and `-c user.signingkey=<key>`/`-c
gpg.program=<wrapper>` on the one invocation that needs them. Two reasons:
first, a tool whose entire job is *enforcing* a policy should not be able
to silently do the wrong thing because some unrelated `git config` call
left a stale `user.signingkey` lying around in the repo — reading
exclusively from a policy file the caller must explicitly point at (or put
in one of two fixed, deliberate locations) means there is exactly one
source of truth, every time. Second, the repos this runs against are
meant to look like an ordinary human's repo once published; a committed
`.git/config` with a bot's signing key configured is itself a tell.
`lib/signer.ts`'s `createSigner()` is generalized to accept an explicit
`signingKey`/`signTime` (used only by git-sign); its two original call
sites (`squash.ts`, `rewrite.ts`) pass neither and keep reading the repo's
own config, unchanged.

**Signature time is `max(chosen date, key creation + 60s)`, not always
`created + 60s`.** D1's original formula assumes the chosen date is always
either "now" or an anonymised 1970 placeholder, both of which the key
postdates by construction. git-sign's dates are real, chosen dates, which
may be *after* the key's creation by years — pinning the signature to
`created + 60s` regardless would put a 2026 commit's signature in 1970,
visibly wrong the moment anyone runs `check`. The `max` makes the rule
correct for both cases without the two original call sites changing at
all (their chosen dates still always precede `created + 60s`, so `max`
there is a no-op).

**`check`'s exit 1 prints violations — the one deliberate exception to §
0's "nothing on stdout on a refusal".** Every other refusal in this spec is
silent on stdout by design (a usage mistake or a failed precondition is not
information the caller asked for). `check` is different: it is the pre-push
gate every agent is expected to run, and its entire output *is* the
violation list — a silent exit 1 would tell a caller nothing actionable.
Decided and documented as an explicit carve-out (§ 5.4) rather than bent
into the general rule.

**Out of scope for this task, raised separately.** Re-signing already-
published commits (not just tags) to fix an already-leaked signature time
is a rewrite of published `main` history — a materially different, riskier
operation than adding a new tool, and the Lead raises it with the user as
its own decision rather than folding it into this one silently.

## D9: `check` missed the exact leak it exists for (found dogfooding D8 for real)

**The trigger.** The Lead dogfooded git-sign for real, running `check`
against nanojira and git-history-tools with a real policy installed.
`check <nanojira> --range=326fc52..main` reported "0 violations across 13
commits" — but commit `c8d5657`, the very commit D8's own writeup names as
the motivating leak (signature created Thu 14:17, squarely inside the
policy's forbidden working-hours window), was in that range. `check` is
the pre-push gate; a pre-push gate that is silent on the one leak it was
built to catch is worse than no gate at all, since it actively tells a
caller the history is clean.

**Root cause: a date string isn't an epoch, and a regex that doesn't match
isn't the same as "nothing to flag".** `gpg --list-packets` prints the
signature's real creation epoch on the packet line itself
(`version 4, created <epoch>, ...`), and, several lines further down, a
*human-readable date* on a hashed-subpacket annotation
(`hashed subpkt 2 len 4 (sig created 2026-10-17)`) — a date, not an epoch.
`signatureCreationTime()`'s original regex, `/\(sig created (\d+)\)/`,
targeted that second line, but `\d+` immediately followed by `)` never
matches a hyphenated date like `2026-10-17)` — the regex simply fails to
match, returning `null`. The caller treated `null` as "nothing to check",
i.e. a pass, rather than "the time is unknown, so this must be flagged" —
exactly the fail-OPEN failure mode D8 itself should have guarded against
for every other check in `check`, but didn't for this one. Fixed two ways,
not one: (a) `signatureCreationTime()` now reads the epoch from the
packet's own `version N, created <epoch>,` field, which is simpler, is a
real epoch, and happens to coexist in the same gpg output as the broken
line, meaning both the correct value and the original decoy are visible
in the same `--list-packets` dump — a reminder to read packet dumps packet
by packet, not line by line; (b) independent of (a), a present signature
whose time *still* cannot be parsed for any other reason is now itself a
`check` violation (`sig-time signature creation time could not be read`),
never silently a pass — so a *future* parsing gap fails closed instead of
repeating this exact incident with a different root cause. Mutation-tested
by reverting each fix independently (test/ac/ac-49-sign-check-hardening.ts
AC-49.1/1b): the old regex alone still gets caught by the fail-closed
path, and the fail-closed path alone still gets caught once the regex
mutation is reverted on its own — confirming the two fixes are genuinely
independent, not one accidentally masking an incomplete other.

**Four more issues surfaced in the same dogfood pass, fixed alongside:**

- `check <repo> <rev-range>` (positional, as both the brief and § 5.4
  describe it) was accepted syntactically but silently ignored — only
  `--range=` ever took effect, and any extra positional fell through to
  the `@{upstream}..HEAD` default instead of erroring. Fixed to accept the
  range positionally (giving both forms is a usage error, not a silent
  pick-one), and generalized § 0's "unexpected argument" check to
  `commit`/`tag` as well, which previously only enforced it via `parseFlags`
  rejecting unknown flags, not a genuinely unexpected extra positional.
- `check --tags` flagged every one of git-release-squash's anonymous
  1970-01-(i+1) 12:00 placeholder tagger dates as a forbidden-window
  violation. Added the optional policy key `anonymousBefore` (§ 5.0): an
  author/committer/tagger date before it is exempt from the
  forbidden-window check ONLY — never identity, message, or `sig-time`,
  since an anonymised commit's *signature* is still made in real time
  regardless of what date the commit itself claims.
- `forbiddenMessagePatterns` compiled case-sensitively, so a pattern
  written as `Co-Authored-By: Claude` would not match GitHub's own actual
  trailer casing, `Co-authored-by:`. Compiled with `'i'` everywhere a
  pattern is used (`lib/policy.ts`'s `compilePattern()`, shared by both the
  load-time compile-check and the runtime match, so the two can never
  drift on flags).
- `check`'s `signature` violation was one generic "missing or invalid" for
  every failure shape, while several old nanojira tags individually hit
  missing/bad/unknown-key/wrong-key — distinct, actionable cases. Added
  `signatureStatus()` (`lib/siginfo.ts`), parsing `git verify-commit`/
  `verify-tag --raw`'s GnuPG status-fd lines (`NO_PUBKEY`, `VALIDSIG`) to
  distinguish them, each now named in `check`'s own output (e.g. "signed by
  unknown key `<keyid>` (not in keyring)", "good signature but by
  `<fingerprint>`, not the policy key").

**Addendum, found by Scout reviewing this area, fixed by Lead (v0.4):**
`zonedOffsetSeconds()` (`lib/policy.ts`) originally derived a zone's UTC
offset via `new Date(s.toLocaleString('en-US', {timeZone: tz}))`, which
re-parses that string in the PROCESS's own timezone, not `tz` — wrong
whenever the two don't match, and silently wrong by exactly one DST hour
around a transition even when they do (e.g. 2026-03-29 04:00 Europe/Berlin
came out +0100 instead of the correct +0200). Fixed to use
`Intl.DateTimeFormat(...).formatToParts()` + `Date.UTC()`, never routing
through a second, ambient-TZ-dependent `Date` parse. `resign-commits`
(D11) is unaffected: it never calls `zonedOffsetSeconds` or computes an
offset of its own — every author/committer/tagger date it writes is the
original's `@<epoch> <offset>` carried through byte-for-byte.

## D10: anonymous objects' sig-time checked against the D1 pin, not the windows (found dogfooding D9)

**The trigger.** Lead dogfooded `check --tags` again after D9 landed,
against tags re-signed by hand and against every future anonymous release
from git-release-squash. It flagged `sig-time` on every one of them: the
D1 pin (`key creation + 60s`, a fixed instant — for the key in play here,
Mon 2026-10-12 10:47:59) fell inside the policy's own forbidden working-
hours window, since a fixed instant will eventually land inside *some*
window on *some* weekday no matter what it is. That is a false positive,
not a leak: the pin is the same single instant for every anonymous object
signed by that key, constant and already public (the key's own creation
time is visible in the public key itself) — it reveals no committer work
time at all, unlike a real, varying signature time would.

**The fix is a different rule for `sig-time`, not an exemption from it.**
`anonymousBefore` (D9) already exempts an anonymised object's *own* date
from the forbidden-window check; it was tempting to extend the same
exemption to `sig-time`, but that would silently accept ANY signature time
on an anonymised object, including a real leaked one — exactly the D9 gap
re-opened one level up. Instead, for an object whose own date (committer
for a commit, tagger for a tag) is exempted by `anonymousBefore`,
`sig-time` switches rules entirely: the signature time must equal
`key creation + 60s` EXACTLY (the same pin D1's signer already produces by
construction, via `max(chosen date, created + 60s)` with an anonymised
chosen date always far smaller than `created + 60s`). Anything else —
including a real workday instant that would otherwise look perfectly
unremarkable — is now itself a violation, named distinctly from "falls in
a forbidden window" (`anonymous object not signed at the pinned time
(expected <t1>, got <t2>)`) since the failure shape is different: not a
leaked work time, but a signature that was never pinned the way D1
requires at all, which is arguably a more serious finding (someone signed
an anonymised object by hand, off the one path D1 enforces).

A real-dated object (not exempted by `anonymousBefore`) keeps the original
window rule unchanged, per the matching code path in `checkOneCommit`/
`checkOneTag`: `sigTimeViolation()` takes the same `anonymous` boolean
`isExemptAnonymousDate` already computes for the date check, applied to
`sig-time` as an independent decision.

**Mutation-tested** (test/ac/ac-49-sign-check-hardening.ts AC-49.6):
removing the pin branch entirely (falling back to the window rule
unconditionally) fails the "wrong pin is a violation, correctly worded"
assertion; forcing `anonymous` to always be `false` fails the same
assertion — confirming the exemption-detection wiring and the pin-exactness
rule are both independently exercised, not one masking a gap in the other.

## D11: `check` crashed instead of refusing on a bad range; `resign-commits` added; a real commit older than the key must be clamped too (found dogfooding, v0.4)

**(A) The trigger.** Lead ran `git-sign check <nanojira> v0.1~1..HEAD` —
v0.1 is nanojira's own root commit, so `~1` doesn't resolve — and got an
uncaught `GitError` and a raw Node stack trace on stderr, not a refusal.
Grepping every `git.text()`/`git.buffer()` call in `sign.ts` (the only two
methods that throw on a non-zero git exit; `git.run()` never throws) found
exactly one fed a directly user-supplied range: `resolveRevList`'s
`git rev-list --reverse <range>` inside `cmdCheck`. Every other `.text()`/
`.buffer()` call in the file operates on an already-resolved sha or an
already-validated tag name, never on a string typed by the caller, so
this was the only crash vector of its kind. Fixed by moving the git call
onto `git.run()` and converting a non-zero exit into
`Refusal('invalid revision range \'<r>\'')` by hand — the same pattern
`cmdResignCommits` (below) now also uses for its own range argument.
Reproduced the exact original crash by reverting the fix (test/ac/
ac-50-sign-check-invalid-range.ts), confirmed it disappears with the fix
back in place.

**(B) `resign-commits <repo> <lower>..<upper> [--apply] [--map-out=<file>]`
added** — the tool for re-signing published history now that the user has
approved doing so for real (2026-10-18). Rewrites `<lower>..<upper>` and
every descendant of it on any local branch or tag (`git rev-list
--branches --tags ^<lower>`), since a descendant's parent hash changes
too whether or not it is itself "in range" — computed this way rather
than walking `<upper>`'s own branch alone, specifically so a second
branch forked partway through the range is caught. Range syntax is
restricted to the two-dot form with an explicit `merge-base
--is-ancestor` check that `<upper>` actually descends from `<lower>`;
neither is in the literal brief, but an ambiguous or backwards range has
no sensible "every descendant" meaning, so both are refusals rather than
a silent empty or wrong rewrite set. Precondition (checked before any
write, dry run or not): every commit to be rewritten must already be
authored and committed by the policy identity, or refuse naming it —
identities are never changed here. Merge commits in the rewritten set are
refused by the same rule as git-release-squash. Tree/author/committer/
message/every other header stays byte-identical (verified after the fact
by stripping only `parent`/`gpgsig` lines from the raw object and
comparing bytes, rather than trying to re-derive or special-case every
possible header `commit-tree` has no flag for); only the signature
changes. Refs: branches whose tip was rewritten move; annotated tags on a
rewritten commit are re-created on the new hash (same tagger line/message,
D1/D10 sig-time rule); lightweight tags move directly; remote-tracking
refs are never read or touched. Dry run writes nothing and, like § 5.1's
`commit`, honestly cannot preview the new shas (signing and writing are
the same step for `commit-tree -S`). `--apply` backs up first (§ 4.1),
then verifies tree/header/parent/signature correctness and reuses
`check`'s own `checkOneCommit`/`checkOneTag` against the new shas, never
pushing — it prints the exact `git push --force-with-lease=<ref>:<old>
origin <ref>` command per moved ref instead.

**The second bug, found only by dogfooding on nanojira's and
git-history-tools' own real history (not by any synthetic fixture until
one was added afterward).** The first cut of `cmdResignCommits` set the
new signature time to the commit's (or tag's) own real date VERBATIM for
any object not covered by `anonymousBefore` — no clamp. D1 already
established, and `cmdCommit`/`cmdTag`/`cmdResignTags` already enforce,
that a signature can never predate its own key: every one of them computes
`max(chosen-or-tagger-epoch, created + 60s)`. `resign-commits` skipped
that `max()` for real dates, reasoning (wrongly) that an already-real,
already-committed date needs no clamping since it's not being chosen
fresh. Running the dry-run-then-apply pair against an actual clone of
nanojira (`326fc52^..main`) hit this immediately: commit `36aba8e`
(2026-09-05) predates the project's actual signing key (created
2026-10-12), so `commit-tree -S` failed with gpg's own `time warp or
clock problem` error — a crash, not a refusal, on the apply path. Fixed
by applying the identical `max(epoch, created + 60)` clamp used
everywhere else, in both the commit loop and the tag loop. Regression
test added (test/ac/ac-51-sign-resign-commits.ts AC-51.5: two commits
dated 2023, before the test's own throwaway key); mutation-tested by
removing the `max()` again, which reproduces the same time-warp crash in
the synthetic fixture too, confirming the test exercises the real
failure mode and not a different one.

**An open question this surfaced, deliberately left undecided here.**
Once clamped, every such real-but-too-old commit gets the SAME fixed
instant (`created + 60s`) as its new signature time — and that instant,
like the D10 anonymous pin, is a constant, already-public value, not a
leaked work time. But unlike D10, these commits' own dates are real, not
`anonymousBefore`-exempt, so `check`'s `sig-time` rule (D10) does not
switch to the pin-exactness branch for them — it keeps applying the
ordinary forbidden-window check, and the clamped instant (Mon 2026-10-12
10:47:59 Europe/Berlin) happens to fall inside this policy's own working-
hours window. So a `resign-commits --apply` run against nanojira's real
history leaves several newly-resigned commits failing `check` with an
ordinary "falls in a forbidden window" `sig-time` violation — correctly
surfaced (the tool's own post-apply verification step catches this and
exits 1, rather than reporting a false success), but not yet a question
this change answers: should `check` treat *any* signature time exactly
equal to `created + 60s` as pin-exempt, regardless of whether the
object's own date is itself `anonymousBefore`-exempt? That would broaden
D10's scope from "anonymised objects" to "any object whose signature was
clamped to the key-creation pin for any reason." Left for the user/Lead
to decide; `resign-commits` does not make this call unilaterally — it
reports the verification failure honestly and stops.

## D12: a non-existent or ambiguous `--date` wall time is a refusal, not a silent shift (v0.4)

**The bug.** `epochForZonedWallClock()` (`lib/policy.ts`) converts a
`--date`'s wall-clock fields (policy.timezone) to an epoch by checking
which UTC offset the zone actually uses around that instant. Around a DST
transition this can go wrong two ways: a spring-forward gap (e.g.
2026-03-29 02:00-03:00 Europe/Berlin simply doesn't exist) had no offset
that validates, so the function silently fell through to *some* nearby
offset and returned an epoch an hour away from what was asked; a
fall-back repeated hour (e.g. 2026-10-25 02:00-03:00, which happens
twice, once at each offset) had two valid candidates and the function
picked one arbitrarily. Either way, the caller got back a usable-looking
epoch that quietly didn't mean what the `--date` string said.

**The fix: refuse, don't guess — the same principle as D1's "no silent
now".** D1 already refuses to let a signature time default to "whatever
`Date.now()` happens to be" without the caller asking for `--date=auto`
explicitly; a wall-clock time that is genuinely ambiguous or doesn't
exist deserves the identical treatment, not a best-effort guess that
differs from what was asked by exactly one DST hour. `epochForZonedWallClock`
now collects every candidate epoch whose own computed offset round-trips
back to the requested wall clock: zero candidates (the gap case) or more
than one (the repeat case) is a `Refusal` naming the wall time, the zone,
and — for the ambiguous case — both candidate offsets, each ending "give
an explicit offset" (an explicit `+HH:MM` on `--date` bypasses this
resolution entirely, going straight to an epoch with no zone lookup
needed). The function's signature and every caller in `sign.ts` are
unchanged; only its failure behavior at the two transition edges changed,
from "pick something" to "say which two things and ask the caller to
pick."

**Addendum, same area, independent fix:** `zonedOffsetSeconds()` itself
(the offset lookup `epochForZonedWallClock` calls) had a separate bug —
see the D9 addendum — fixed by routing the offset computation through
`Intl.DateTimeFormat(...).formatToParts()` instead of a second, ambient-
process-TZ-dependent `Date` parse. The two fixes are independent: this
one changes what happens when zero or two candidates are found; that one
changes whether a given candidate's offset is computed correctly in the
first place.

## D13: a real signature clamped to the key floor lands on the first ALLOWED minute, not the raw pin (resolves D11's open question)

**The question D11 left open.** `resign-commits`'s clamp fix (D11) pinned
a real (non-anonymous) commit whose own date predates the signing key to
`created + 60s` — the same rule `commit`/`tag`/`resign-tags` already used.
That raw instant is a single constant for a given key, so it leaks
nothing, same reasoning as the D10 anonymous pin — but dogfooding against
nanojira's actual history, that constant happened to land on a Monday
morning, inside the policy's own 07:00-19:00 weekday forbidden window.
`check`'s `sig-time` rule (D10) does not treat a real object's clamped
signature as pin-exempt — only `anonymousBefore`-exempt dates get the
pin-exactness branch — so it correctly, if unhelpfully, flagged every
such resigned commit as a fresh "falls in a forbidden window" violation.
D11 left the fix for this as an open question rather than deciding it
unilaterally.

**The decision: no exemption in `check` — fix the clamp instead.** Rather
than teaching `check`'s `sig-time` rule a second pin-exactness case (one
that would have to reconstruct, from the signature time alone, whether it
equals *some* key's `created + 60s` without knowing which key signed
non-anonymous history), the clamp itself now targets a value that can
never be forbidden in the first place: `keyFloor = signTimeFor`'s new
real-date branch computes the first minute, at or after `created + 60s`,
that `policy.forbiddenWindows` actually allows (`firstAllowedMinuteAtOrAfter`,
`lib/policy.ts`, walking forward minute-by-minute the same way
`nextAllowedMinuteAfter` already does, but inclusive of its own starting
instant rather than strictly after it). `keyFloor` is still a constant for
a given key+policy pair — it leaks nothing a real, varying signature time
would — so this trades nothing away relative to the raw-pin approach,
while making `check` correct by construction instead of by special case.
For the throwaway key used while dogfooding (`BEEEE63B...`, created Mon
2026-10-12 10:47:58 +0200, inside the window), `keyFloor` is Mon
2026-10-12 19:00:00 +0200 — the window's own end, the first instant that
day the policy allows anything to be signed at all.

**The D1/D10 anonymous pin is explicitly UNCHANGED.** `signTimeFor`
still returns `keyCreated + 60s` exactly, with no floor-walk, whenever the
object's own date is `anonymousBefore`-exempt — published 1970-era
releases (git-release-squash's anonymised history) already depend on
that exact value, and `check`'s pin-exactness branch for anonymous
objects (D10) still checks it in exactly that form. D13 only changes the
floor used for a REAL date that happens to predate the key; the two
branches of `signTimeFor` remain independent, matching `isExemptAnonymousDate`'s
own existing boolean split.

**Applied uniformly.** `signTimeFor(epoch, policy, keyCreated)`
(`lib/policy.ts`, next to `nextAllowedMinuteAfter`) is now the single
place this logic lives; `commit`, `tag`, `resign-tags`, and
`resign-commits` (both its commit loop and its tag loop) all call it
instead of each repeating their own `max(epoch, created + 60)`. For the
overwhelmingly common case — a real date already at or after the key's
own floor, which is true of nearly every ordinary commit/tag, since
`commit`/`tag` never let a chosen date be inside a forbidden window in
the first place — `signTimeFor` returns `epoch` unchanged; the new floor
logic only ever activates for a date that truly predates the key.

**Mutation-tested** (test/ac/ac-51-sign-resign-commits.ts AC-51.5,
extended; test/ac/ac-52-sign-commit-date-before-key.ts, new): both
fixtures deliberately construct a forbidden window that covers the raw
`created + 60s` pin, so the old behavior (reverted: `signTimeFor`'s
real-date branch falls back to `max(epoch, keyCreated + 60)` with no
floor-walk) is forced to fail in its OWN two distinct ways —
`resign-commits` reproduces the exact gpg "time warp" crash this whole
area was first found from (AC-51.5), while plain `commit` instead
produces a signature that `check` immediately flags with the exact
"falls in a forbidden window" `sig-time` violation this fix exists to
prevent (AC-52) — confirming both tests exercise the real floor-walk
logic, not merely its absence.

## D14: `resign-commits`/`resign-tags` review findings — double-signature corruption, exact range selection, atomic ref moves, tag-on-tag preserved, the 20160-step cap refuses instead of lying (reviewer-found + Lead-found, task 01a14ca4)

A review of D11/D13's `resign-commits` (and, where shared, `resign-tags`)
found five distinct problems. Item 0 was found by Lead while reviewing
the HIGH/MEDIUM fix below, dogfooding the exact "resign something
already signed" case on git 2.53.0; the other four were reviewer-found
and are fixed together since the HIGH and MEDIUM ones touch the same
tag-processing loop.

**Item 0 (CRITICAL): resigning an ALREADY-SIGNED tag silently corrupted
it with two concatenated signature blocks.** Both `resign-tags` and
`resign-commits`'s tag-recreation path built the new tag's message from
`git for-each-ref --format=%(contents)` — which, for a tag that is
ALREADY signed (the single most common real case: re-signing something
that was already fine, or already signed by the wrong key), includes the
existing trailing `-----BEGIN PGP SIGNATURE-----...-----END PGP
SIGNATURE-----` block as part of its own output. That whole blob,
signature included, was then written as the NEW tag's "message" via
`-F`, and signed again — leaving a tag object with the OLD signature
embedded as literal message text, immediately followed by a genuinely
NEW, real one.

Two separate checks that looked like they should have caught this both
missed it, for related reasons: the byte-identity check (`stripSignature`/
`tagBodyMinusSig`, both truncate at the FIRST `-----BEGIN PGP
SIGNATURE-----` marker) produced the SAME truncated prefix on the old and
new side regardless of whether a second block followed, so the comparison
still passed; `git tag -v` verified the first of the two blocks happily
and never noticed the second. Both are reproduced directly in AC-57,
which mutation-tests the fix by reverting to `%(contents)` and confirming
`verify: ...: FAILED (multiple-signatures)` is what `--apply` itself would
have reported — not a silent `OK`.

**The fix, three parts:**
1. The message is now read from the raw object (`git cat-file -p`,
   already fetched in the SAME function for other header fields in every
   case — eliminating a redundant subprocess call too), everything after
   the header's blank-line separator, truncated at the first signature
   marker if one follows. Truncating at the first marker is the CORRECT
   behaviour here regardless of how many blocks happen to follow — every
   byte from the first one onward is signature material, never part of
   the real message to preserve.
2. **Exactly 1 signature block, never 0 or 2+, in the verification.**
   `resign-tags`'s own bespoke verify loop now counts blocks directly (a
   4th condition alongside target-unchanged/body-unchanged/`tag -v`);
   `resign-commits` inherits the same guard for free by reusing `check`'s
   own `checkOneTag` for its tag verification, which gained the identical
   check as part of point 3.
3. **`check` reports `multiple-signatures` as its own violation, checked
   before `missing`/`bad`/anything else** (§ 5.4) — for BOTH a tag (2+
   `-----BEGIN PGP SIGNATURE-----` markers) and a commit (2+ top-level
   `gpgsig` headers; a commit can't be corrupted by this specific
   %(contents) bug, since nothing here ever builds a commit's message
   that way, but the detection is symmetric defense regardless of cause).
   `siginfo.ts`'s `extractSignature` is hardened to match: it refuses to
   hand a multi-block object to gpg at all (returns null, same as
   "missing" at that layer), and the NEW exported `signatureBlockCount`
   is what callers use to tell "truly missing" apart from "multiple,
   garbled" for reporting purposes — never silently treating the first of
   several blocks as if the object were normal. AC-58 hand-constructs
   both shapes directly via `git hash-object --literally`, independent of
   this bug or any other single tool, since `check` must catch this
   regardless of how an object came to look that way.

**Mutation-tested**: AC-57 (reverting both call sites to
`for-each-ref --format=%(contents)` reproduces 2 signature blocks exactly,
`verify: ...: FAILED (multiple-signatures)`, and `check --tags` reporting
the same); AC-46/AC-51 hardened with an explicit exactly-1-block
assertion on their own pre-existing already-signed-tag fixtures
(`v-wrongkey`, `v-already-good`, `v1`), which would have failed against
the original bug had they checked this before.

**CRITICAL: range selection caught commits with no relation to `<range>`
at all.** `rev-list --branches --tags ^<lower>` alone means "everything
NOT an ancestor of `<lower>`" — not "every descendant of `<lower>`". An
orphan branch (unrelated history entirely) and a side branch forked AT
`<lower>` itself (never merging back into the range) are both "not an
ancestor of `<lower>`", so both were silently caught, re-signed, and
moved, despite having nothing to do with the requested range. Proven by
AC-54's fixture. Fixed per § 5.5's "Precise selection rule": R0 =
`rev-list <lower>..<upper>`; walk the same candidate superset in
topological order, marking a candidate for rewrite only if it is in R0 or
a real parent is already marked — true transitive descendance, computed
in one pass.

**HIGH: ref moves were not atomic.** Each affected branch (`update-ref`)
and signed tag (`git tag -f -s`, which creates the object AND moves the
ref in one step) was moved sequentially. A failure partway through (the
Nth tag's signing, say) left every ref processed so far already moved,
and everything after it untouched — a half-rewritten repo, with no way
back short of the backup bundle. Fixed per § 5.5's "Atomicity": every new
object is created first — a tag's new object via `buildSignedTagObject`
(see below for the two approaches tried before this one, and why both
have a real crash window this one does not), a commit's via `commit-tree`
(never touches a ref at all, same as always) — then every branch and tag
moves together in ONE `update-ref --stdin` transaction, each old value
checked, all-or-nothing. Applied to `resign-tags` too (it can move
several tags in one invocation, same exposure).

**Two approaches to building a tag's new object were tried before the
one that actually lands, both worth recording as pitfalls.**

*Attempt 1 — a disposable temporary tag name.* The natural-seeming fix
for "`git tag -s` both creates the object and moves the ref" is to
create the object under a throwaway temporary tag name, read its oid,
then delete the temp ref. For a TAG this silently corrupts the object
itself: a tag object's `tag <name>` header is part of its own permanent
content, recorded at creation time, not merely a ref pointer — so
creating it under `git-sign-tmp--<name>` bakes that exact wrong string
into the object forever, discovered only because Scout's pre-existing
AC-46 asserts the tag's bytes (including this header) are unchanged
across a resign, which none of this fix's own new AC files happened to
check.

*Attempt 2 — create under the real name, then revert the incidental ref
move.* The next fix let `git tag -f -s` create the object under its REAL
name (incidentally moving the real ref, same as it always has), then
immediately reverted that ref to its old value — deferring the actual
move to the one transaction, while never touching the object's own
content. This passed every AC in this round, but Lead found it is not
actually atomic on its own terms: a process killed between the `tag -f
-s` and the revert leaves that one ref pointing at the new object while
every other ref (and the transaction meant to move all of them together)
never runs — exactly the half-rewritten state the whole HIGH fix exists
to prevent, just narrowed to one ref instead of all of them.

*What actually lands: build the object with no ref involved at all,
mirroring `commit-tree`.* `buildSignedTagObject` (lib/sign.ts) writes the
tag's raw text itself (`object`/`type`/`tag`/`tagger`/blank
line/message, byte-for-byte what `git cat-file tag` would show), signs
it DETACHED via the same `--faked-system-time` gpg wrapper `createSigner`
already builds (now also exposed directly as `Signer.gpgProgram`/
`.signingKey`, for this exact non-git invocation), appends the armored
signature, and writes the whole thing with `git hash-object -t tag -w
--stdin` — which, like `commit-tree`, never creates or moves a ref. No
ref is touched until the one closing `update-ref --stdin` transaction, so
there is no window, however narrow, where one ref can end up moved
without the rest. As a side effect this also closes item 0 for good: the
message comes from the object's own raw bytes, never from
`for-each-ref --format=%(contents)`, so the corruption path that
decision describes has no code path left that could reintroduce it.

**MEDIUM: tag-on-tag was flattened.** An outer signed tag whose immediate
target is another (inner) signed tag, not a commit, was re-created
pointing straight at the new commit, silently dropping the inner tag from
the chain. Fixed per § 5.5's "Tag-on-tag": resolved via an iterative work
queue (a tag's new target is only known once its own immediate target's
new object exists), pinned by AC-56.

**LOW: the 20160-step allowed-minute search cap could return a
still-forbidden instant.** `nextAllowedMinuteAfter`/`firstAllowedMinuteAtOrAfter`
walked forward at most 14 days looking for an allowed minute, then
returned whatever they landed on even if the cap was hit first — silently
signing at a forbidden instant rather than refusing. Under the current
schema (`forbiddenWindows[].to` capped at `23:59`, `from < to` required)
this can never actually happen via any policy.json a real user could
write, since the literal minute `23:59` is never excludable — which is
why AC-53 is a white-box unit test (importing `lib/policy.ts` directly,
unlike every other AC file here) hand-building a schema-circumventing
`Policy` to exercise the cap at all. Fixed defensively anyway: both
functions now return `null` once the cap is exhausted, and `signTimeFor`
refuses (naming `forbiddenWindows`) rather than signing at the `null`
result.

**Mutation-tested** (AC-54 against the reverted `^<lower>`-only
selection; AC-55 against the reverted sequential-move logic, via a
pre-existing `refs/tags/<name>.lock` file forcing a deterministic failure
on the second of two tags; AC-56 against a reverted flatten-onto-commit
branch; AC-53 against the reverted return-whatever-was-reached cap):
each reproduces the exact symptom the corresponding fix exists to
prevent.

## D15: `resign-commits` had no way to express "from the root", and silently gave no record of a signature it could not verify (Lead-found, dogfooding nanojira's whole real history, task 01a14ca4)

Scoping the eventual re-sign to nanojira's whole history (every commit
from the root, not just a tail range from a chosen cut point) surfaced
two gaps neither of D11/D13/D14's fixtures exercised, since all of them
range over a HISTORY THAT ALREADY HAS a resolvable commit before the
one being re-signed.

**`<range>` had no way to say "root commit included".**
`<lower>..<upper>` requires `lower` to resolve to an existing commit
(`lower^{commit}`) and is lower-exclusive by convention — there is no
earlier commit to name for the very first commit a history ever had.
Fixed by accepting a bare `<range>` with no `..` as meaning "every
ancestor of `<range>`, root included" — the same thing a single revision
already means to `git rev-list` itself, so R0 (`resolveRevList(repo, env,
[range], range)`) needed no change at all; only the candidate superset's
walk (`--branches --tags`, previously always `^<lower>`) and the
`merge-base --is-ancestor` sanity check now skip the lower side entirely
when there isn't one. `parseCommitForResign`'s 0-parent handling, and
`cmdResignCommits`'s own `p.parents.length === 0 ? null : ...` for the
new parent, already did the right thing for a root commit — this was
purely a range-parsing gap, not a rewrite-logic one.

**An existing signature `resign-commits`/`resign-tags` cannot verify at
all (no public key for it) was replaced with no record it ever
differed.** Both commands already unconditionally overwrite ANY existing
signature regardless of its own validity — neither ever refused or
crashed on one with no key to check it against (`verifiedKeyFingerprint`/
`signatureStatus` already handle `NO_PUBKEY` as "not the policy key,
replace it" without incident). What was missing was naming it: nanojira's
own pre-v4.0.0 history is signed entirely by a key since dropped from
every keyring in this task, and silently replacing that signature with
no mention of what it used to be is the kind of silent change a security
history re-sign should never make. Fixed by checking each commit/tag's
OLD `signatureStatus` before resigning it; when the state is
`unknown-key` (NO_PUBKEY), both commands now print an extra line naming
the old key id (`<sha> would replace unverifiable signature (key
<keyid>)` in dry run, `<sha> replaced unverifiable signature (key
<keyid>)` in apply) — deliberately NOT for `wrong-key` (a different but
cryptographically GOOD signature — already a distinct, already-reported
situation, not "unverifiable") or `bad` (no key id exists to name at
all).

**Mutation-tested** (AC-59: reverting the bare-`<range>` acceptance back
to an unconditional `UsageError` reproduces the exact "must be
`<lower>..<upper>`" refusal on a root-inclusive range; reverting
`unverifiableKeyLabel` to always return `null` reproduces the silent,
unnamed replacement for both a commit and a tag signed by a key outside
the keyring).

## D16: the signature-boundary rules ("truncate/count at the FIRST marker", "count every marker/header anywhere") both over-fire on legitimately quoted content (Lead-found, pre-review of D14's own fix, task 01a14ca4)

D14's item-0 fix reads a tag's message from the raw object, truncated at
the first `-----BEGIN PGP SIGNATURE-----` marker, and counts every such
marker anywhere in the object to detect the corrupted double-signature
shape; `signatureBlockCount`'s commit case counted every top-level
`gpgsig ` line anywhere in the object. Both rules are wrong for an
object whose own MESSAGE legitimately contains something that LOOKS like
a signature boundary — a tag quoting an old security advisory's PGP
block as literal text, or a commit message with a line that happens to
start with "gpgsig " as prose, neither of which is unusual once release
notes or documentation commits start quoting real signatures.

**Tags: boundary moves to the LAST marker; "multiple" is redefined as a
STACKED check, not a raw count.** `lastTagSignatureBeginIndex`
(siginfo.ts) finds the LAST signature-marker line in the object, not the
first — the REAL, currently-valid signature is necessarily the last one
in the object regardless of any earlier quote, since
`buildSignedTagObject`/`git tag -s` always appends it last. Message
extraction (`tagMessageFromRaw`, `stripSignature`, both lib/sign.ts) and
signature extraction (`extractSignature`, siginfo.ts) both use this
instead of the first-marker search. `signatureBlockCount`'s tag case
stops counting "every BEGIN marker anywhere" and instead walks backward
from EOF (`stackedTagBlockCount`): each complete `BEGIN...END` block
immediately preceded (modulo blank lines) by another complete block
counts as one more stacked layer. A quoted block followed by further
real text before the real signature is NOT part of this stack (count
stays 1, no violation); a quoted block with NOTHING between it and the
real signature IS part of the stack (count 2+, still `multiple-
signatures`) — genuinely indistinguishable from item-0's own corruption
shape from the object's bytes alone, so this is deliberate, not a gap:
D1 (Lead's own framing) explicitly keeps this case a violation.

**Commits: `gpgsig`/`gpgsig-sha256` counted in the HEADER REGION ONLY.**
`signatureBlockCount`'s and `extractSignature`'s commit cases now split
the raw object at its own header/message blank-line separator first, and
only scan the header side — a message line starting with "gpgsig " is
never reachable by either function anymore. `gpgsig-sha256` (SHA-256
object-format signing) is matched alongside `gpgsig` everywhere this
applies, for the same reason as the base case, even though no fixture
here exercises it — `headersMinusParentsAndSig` (the resign-commits
byte-identity check) gained the same `gpgsig-sha256` match for
consistency, though it already correctly scoped itself to the header
region before this decision.

**Mutation-tested** (AC-61: reverting `lastTagSignatureBeginIndex` to a
first-marker search and `stackedTagBlockCount`'s caller back to a raw
occurrence count reproduces the exact false `multiple-signatures` and
truncated-message symptoms on the quoted-block tag fixtures; reverting
the commit case back to a whole-object scan reproduces a false
`multiple-signatures` on the gpgsig-prose commit fixture) — each turns
red on the mutation and green on the fix, run back to back against the
same fixtures.

Also folded into this task: D3 (Lead's framing) — AC-49.3 gained a leg
for the EXACT boundary instant `epoch === anonymousBefore`, proving
`isExemptAnonymousDate`'s existing `<` (strict) is correct and would
wrongly exempt the boundary instant itself under a `<=` mutation
(code was already correct; only the test coverage was missing — caught
by the harness fixture `writePolicy` not forwarding `anonymousBefore` at
all, fixed alongside it, test/lib/harness.ts).

## D17: docs audit of v0.4's git-sign — a root-inclusive re-sign needs `--from-root`, gpg comes from the policy only, and smaller CLI fixes (Lead-decided, docs audit before release)

A read-only audit compared README/SKILL/SPEC against git-sign's real
behaviour in a scratch repo. Most deviations were doc-only (patch 04 of
the 0.4.0 doc patches); the ones below changed code, each per the Lead's
decision.

**`resign-commits <rev>` requires `--from-root` (audit #1).** D15's bare
form re-signs every ancestor down to the root plus their descendants.
`main` and `HEAD~3` both read like "that commit" / "the last few", and
in the audit `resign-commits <repo> HEAD~3` rewrote the whole history —
a doc warning alone is too weak for an operation whose every result
needs a force push. A bare `<rev>` is now a usage error naming
`--from-root`; `<rev> --from-root` keeps D15's meaning, and its dry run
starts with `resign-commits: root-inclusive: <N> commits` so the scale is
the first thing read. The range's shape (`...`, an empty side,
`--from-root` with a `..` range) is checked before the repo and policy,
as usage errors, each with ONE `git-sign:` prefix — the old messages
carried `resign-commits:` inside the reason, printing two (audit #5).

**gpg comes from the policy, never from git config (audit #3).** SPEC § 5
already said git-sign does not read `gpg.program` from `<repo>`'s
config, but the code did (`gpgProgramFor`), so a repo — possibly a
freshly cloned, untrusted one — could choose the binary git-sign runs
with the user's key. Two options were weighed: (a) document the read, or
(b) stop reading it. (b): the optional policy key `gpgProgram` (an
absolute path to an executable regular file, validated at load) names
the binary, default `gpg` from `PATH`. Because git's own `verify-commit`/
`verify-tag`/`tag -v` would still consult git config, every git
invocation git-sign makes gets `gpg.program` forced through a
`GIT_CONFIG_COUNT` environment override (appended after any the caller
already set, so it wins). AC-63 proves a trap `gpg.program` in the repo
is never executed by `check`, `commit --apply` or `resign-commits
--apply`.

**Push hints and unchanged objects (audit #4, #15).** `resign-commits`
printed `origin` in its push hints while `resign-tags` printed the
`<remote>` placeholder; both now print `<remote>` — the tool never
inspects remotes. With ed25519 (deterministic) and an unchanged
signature time, a re-sign can reproduce the identical object; such a
tag/commit line is marked ` (unchanged)` and gets no push hint, since
there is nothing to push.

**Help (audit #16).** `git-sign` with no subcommand printed
`unknown subcommand 'undefined'`. `--help`/`-h`/`help` now print every
subcommand's synopsis (stdout, exit 0), `<sub> --help` that one
(checked before flag parsing, so the other arguments never fail it), and
a missing subcommand is exit 2 with `missing subcommand` plus the
synopses on stderr — the one deliberate exception to § 0's one-line
usage error.

**A flag is never another flag's value (audit #17, all four tools).**
`parseFlags` took the next argument as a value flag's value
unconditionally, so `--message --apply` took "--apply" as the message
and silently stayed a dry run. A space-separated value
starting with `--` is now `missing value for --<flag>`; a value that
really starts with `--` is passed as `--flag=--value`.

**Messages and comments (audit #8, #20).** `tag`'s date refusals said
"the parent's committer date"; a tag has no parent, so they now say "the
target's". `--date=auto`'s refusal says "next allowed minute" (it named a
"start" that was always a minute). Section references in lib/ comments
(`policy.ts`, `signer.ts`, `siginfo.ts`, `sign.ts`) point at the right
SPEC sections again.

**Mutation-tested** (AC-62/63/64): removing the `--from-root` check, the
count line, `<remote>`, either unchanged-skip, the `GIT_CONFIG_*`
override, the policy `gpgProgram` lookup, the missing-value rule, or the
"target's" label each turns its test red.

## D18: D16's own fix still had two independent boundary scans that could disagree, plus a genuinely ambiguous tag shape it never addressed (HIGH, Lead-found via the Reviewer's pre-review of D16, task 01a14ca4)

Repro: an UNSIGNED annotated tag whose message quotes a complete PGP
block in the MIDDLE, with real text after it
(`"preamble\n\n<BEGIN...END>\n\nREAL TRAILING TEXT"`). `resign-tags
--apply` reported `verify: OK`, but the resigned tag's message was only
`"preamble"` -- the quote and everything after it were gone.

**Root cause: D16 left TWO independent boundary-finding algorithms that
happened to agree on every case AC-61 exercised, but not this one.**
`lastTagSignatureBeginIndex` was a bare `text.lastIndexOf` over every
marker, with no notion of "is this actually trailing the object" --
`stackedTagBlockCount`'s own backward walk correctly said 0 (nothing real
at EOF), but `lastTagSignatureBeginIndex` still happily returned the
quote's own position, since it was the only (hence "last") marker
anywhere in an unsigned tag. AC-61's own quoted-block fixtures were all
SIGNED tags (`H.tagSigned`), where the real trailing signature genuinely
IS the last marker either way -- so the disagreement never had a chance
to surface there. `cmdResignTags`'s own verify step compared two bodies
BOTH produced by `stripSignature` (built on the same buggy function), so
they agreed with each other at the wrong truncation point and reported
`OK` while the loss happened.

**Fix: one function, `tagSignatureBoundary` (siginfo.ts), replacing both
`lastTagSignatureBeginIndex` and `stackedTagBlockCount`.** A single
backward walk from EOF now answers both "how many stacked blocks" and
"where does the trailing stack start" in one pass -- `index: -1` ("no
boundary") whenever nothing recognizable sits at the very end of the
object. Every caller (`tagMessageFromRaw`, `stripSignature`,
`extractSignature`'s tag branch, `signatureBlockCount`'s tag branch) uses
this one function; there is no second scan left anywhere to disagree with
it.

**Verify independence: `cmdResignTags` no longer trusts one function for
both sides of its own check.** A new `independentOldTagMessage` (lib/sign.ts)
answers the SAME "message minus its trailing signature" question via a
regex anchored at `$`, with a `(?:(?!-----END...)[\s\S])*` middle that
refuses to cross any `END` marker -- necessary because a plain greedy (or
lazy) `[\s\S]*$` still matches starting from the EARLIEST `BEGIN` when a
quote precedes the real signature (the same "first marker" mistake,
reintroduced by accident while writing this very check the first time
around). `cmdResignTags`'s verify step now compares the NEW tag's message
(extracted normally -- the new object has exactly one real, unambiguous
trailing signature by construction) against this independently-computed
OLD message, instead of comparing two values both produced by
`stripSignature`. A shared bug in the ONE walk can no longer truncate
both sides identically and still report `OK`. Trailing-newline COUNT right
at the boundary is explicitly not compared (both extractions legitimately
attribute the blank line's own newlines differently; trimmed before
comparing) -- only actual message content matters.

**New decision: an unsigned tag whose message ENDS with a complete quoted
block is genuinely ambiguous, so both tag-resigning paths now REFUSE
instead of guessing.** Such a tag is indistinguishable, from the object's
bytes alone, from a tag that IS signed but whose signature gpg can
neither verify nor attribute to any key at all (SPEC § 5.5's own "if one
follows" ambiguity, `signatureStatus`'s `bad` state -- deliberately not
`unknown-key`/`wrong-key`, both of which have enough forensic signal, a
real key id or a real other-key `VALIDSIG`, to be confident a genuine
prior signature really was there, safely replaceable). Guessing either
way is wrong half the time: `cmdResignTags`'s apply loop and
`cmdResignCommits`' tag-on-tag loop both now throw a `Refusal` (exit 1,
naming the tag) on `hasSig && oldStatus.state === 'bad'`, rather than
stripping what might be the user's own real trailing message text as if
it were a signature to replace.

**Mutation-tested** (AC-65): reverting `tagSignatureBoundary`'s `index`
to the old bare `lastIndexOf` reproduces the exact truncated-message
symptom, AND -- with the independent verify check also disabled in the
same mutation -- reproduces the false `verify: OK` on top of it, proving
the independent check is not redundant with the shared walk it's meant to
catch. Disabling just the independent check alone (shared walk still
correct) shows no effect, as expected. Disabling either refusal condition
(`cmdResignTags`'s or `cmdResignCommits`' tag-on-tag path, independently)
reproduces silent resigning of the ambiguous-ending tag instead of a
refusal. Each turns red on its mutation and green on the fix, run back to
back against the same fixtures.

## D19: the test runner runs files in parallel, times them, and gives the run one compile cache (test speed, after v0.4.1)

The full run took as long as nanojira's whole suite: 266.1 s serial for
65 files (v0.4.1, measured with the new `GHT_TEST_TIMES`). `test/run-all.ts`
was a strictly serial loop. Key generation, gpg-agent starts and the
bundle/npm files were measured and are minor; the cost is process starts,
above all of the tools themselves.

**Pool.** Files run `--jobs=<n>` (or `GHT_TEST_JOBS`) at a time, default
`min(os.availableParallelism(), 8)` -- a port of nanojira's runner
(its DECISIONS 199/201). Each file's report is buffered and printed in
file order, so the output of a pooled run reads like a serial one, with
the same summary and exit code. `--jobs=1` is the old serial loop. The
async spawn keeps `spawnSync`'s contract (120 s timeout, SIGTERM and a
null status, the 1 MiB output limit the serial loop always had), so a
file's verdict cannot depend on the mode. A header marker `@serial` runs
a file alone after the pool; `@slow` dispatches it first. Every fixture
is a `freshDir()` under the shared run root and nothing writes git's
global or system config, so files do not see each other.

**`GHT_TEST_TIMES=<file>`** writes each file's wall time there (TSV:
file, phase, start_ms, ms, slowest first, then a `total` row), same
format as nanojira's `NJ_TEST_TIMES`. stdout does not change.

**One `NODE_COMPILE_CACHE` per run.** Every `bin/*` call is `node
lib/<tool>.ts`, and a full run makes 290 of them (counted with a wrapping
`GHT_BIN_DIR`): without a cache each one type-strips and compiles `lib/`
again (`bin/git-sign --help`: median 253 ms without, 84.5 ms with, in a
probe under load). The cache is a `ght-node-cache-*` mkdtemp next to the
run root under `GHT_TEST_ROOT` (else `/tmp`): not inside the run root,
because it is no leak, and never in `os.tmpdir()`, which may be on disk.
It is removed at the end, `GHT_KEEP` or not. Testing `dist/` instead
would be faster still, but changes what is under test.

**Proof is external.** No AC file covers the runner itself (`test/ac`
holds only § 6's rows), the same as for the run-root leak sweep. The
proof, on v0.4.1's 65 files:
- Check logs (every `T.check`, per file, including the six files ac-40
  runs as its own children): 1103 checks, ok/FAIL identical between the
  old serial loop, `--jobs=1` and `--jobs=8`; the only textual
  differences are the shas of freshly signed fixture commits, which
  differ on every run.
- Three product mutants (a forbidden-window boundary, the backup bundle
  without `--all`, leak-scan without its email category) fail the same
  9, 18 and 12 checks under the old serial loop and the new pool.
- 11 pooled rounds (`--jobs=8`), all 65/65 and nothing left in the run
  root: 43.7–51.0 s, against 266.1 s serial before (73.8 s pooled
  without the compile cache).
- Timeout margin over those rounds (each `spawnSync` of a test file
  timed in ten of them), every limit at most 25 % used: the
  slowest file took 29.8 s of its 120 s, the slowest `bin/*` call 5.0 s
  of 30 s, ac-40's slowest child 9.0 s of 60 s, key generation 0.3 s of
  30 s and `--list-secret-keys` 0.2 s of 15 s.

**`@slow` follows a fixed rule (v0.4.3).** Fixed in writing before it
was measured, like nanojira's (its DECISIONS 209), but with ght's own
threshold:
- **Ratio:** a file's ratio is its time over the mean of the pool files
  of the same pooled run (`--jobs=8`), `(ms / mean).toFixed(1)`.
- **Value:** the median of three runs, because single runs scatter
  across the threshold (ac-60: 3.7–4.2 in v0.4.1's eleven rounds).
- **Thresholds:** a median of 4.0 or more is marked; below 3.0 is
  unmarked; 3.0–3.9 keeps its current state.
- **Why 4.0, not nanojira's 5.0:**
  - The pool cannot finish before about sum / jobs. That is about 8 ×
    the mean here (66 files, 8 jobs), and about 15 × in nanojira.
  - Files are dispatched in name order, so a file late in the alphabet
    starts at about half that floor. If it takes 4 × the mean, it ends
    after the floor and so sets the wall.
  - This is what ac-60 did: dispatched at 26–30 s, it ran 19–22 s and
    finished last.

**The measurement:** three unmarked pooled runs of v0.4.2's 66 files
(start load 7.0–9.8):
- ac-40: 5.8, 5.5, 5.5, median 5.5, so marked.
- ac-53: 5.0, 4.6, 4.6, median 4.6, so marked.
- ac-60: 4.1, 4.1, 4.2, median 4.1, so marked.
- ac-51: 4.0, 3.7, 3.7, median 3.7, so it stays unmarked.
- Every other file was below 3.0.

**The result:** three marked runs right after, in the same slot
(start load 9.1–10.2):
- Wall 41.5, 41.1 and 40.3 s, against 51.2, 45.3 and 44.5 s unmarked.
  The medians are 41.1 s against 45.3 s.
- Pool sums were alike (296–350 s unmarked, 300–308 s marked). The
  marked wall sits about 3 s above sum / 8, where the unmarked one was
  about 7 s above it.
- All runs were 66/66 with nothing left in the run root.

**Revised (v0.4.3): a timed-out file is a FAIL and cannot outlast the
timeout (AC-67, AC-68).** The pool paragraph above keeps `spawnSync`'s
contract on the timeout: SIGTERM and a null status. That left two gaps.
A file that held SIGTERM through synchronous work could still exit 0
after the timeout and pass, because a JS signal listener only runs once
the event loop is free. A file that ignored SIGTERM was never killed,
and the run waited for it. Now:
- A file still running at the 120 s timeout is a FAIL, whatever it
  exits with later. Its report ends with `run-all: timed out after
  120 s; killed (...)`.
- The pool sends SIGTERM, then SIGKILL after a 10 s grace
  (`KILL_GRACE_MS`). The serial path kills with SIGKILL at once, since
  `spawnSync` cannot escalate. Both still give a null status.
- The harness cleans up on node's `exit` event, so a test that dies
  before `T.finish()` (an uncaught exception, an unhandled rejection, a
  bare `process.exit()`) still removes its fixtures. It installs no
  signal handler, so it never holds a kill itself. What a killed file
  made stays in the run root, which the leak sweep reports and removes.
- This is the same rule as nanojira's harness and runner (its DECISIONS
  193, revised for its TSK-028).
