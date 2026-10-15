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
  generated key. The user's keyring is never touched by tests.
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
