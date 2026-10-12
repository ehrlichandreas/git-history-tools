# Specification — git-history-tools v0.3

This is the precise CLI contract. docs/DECISIONS.md D1 is the scope and shape;
this document pins the exact arguments, output lines, exit codes and refusals
a black-box test can assert on. Where D1 left a choice open, the choice made
here is marked **(decision)** and is binding — a test encodes it, and an
implementation that disagrees is wrong, not the test.

## 0. Conventions

- Layout: `SKILL.md`, `bin/git-release-squash`, `bin/git-leak-scan`, `bin/git-history-rewrite`
  (POSIX `sh` wrappers, `exec node "$(dirname "$0")/../lib/<name>.ts" "$@"`),
  `lib/*.ts`. Node.js ≥ 24, no runtime dependencies (D1).
- Every tool is invoked as `<bin> <subcommand> [args...]`. An unknown
  subcommand, a missing required argument, or an unknown flag is a **usage
  error**: exit 2, one line on stderr, `<bin-basename>: <reason>` (e.g.
  `git-release-squash: unknown subcommand 'plna'`), nothing on stdout.
- A **refusal** (a precondition the repo itself fails, not a CLI mistake) is
  exit 1, one line on stderr in the same `<bin-basename>: <reason>` form,
  nothing on stdout, and the repo is left byte-for-byte unchanged — no ref
  moved, no object written, no bundle created.
- Success is exit 0. Informational output goes to stdout, one line per
  event, in the formats given below; nothing is ever printed to stdout on a
  refusal or a usage error.
- `<repo>` is always a required positional argument: the path to the git
  repository to operate on (never the current directory implicitly). A
  `<repo>` that is not a git repository (no `.git`) is a refusal, not a
  usage error: `<bin>: not a git repository (<repo>)`.
- **(decision)** `--name=<name>` is accepted by `git-release-squash plan`,
  `apply` and `tail`; it feeds the `<name>` in the default subject template
  `<name> <tag>: <title>`. When omitted, `<name>` defaults to the
  basename of `<repo>` with any trailing `.git` stripped.
- **(decision)** `<title>` in the subject template is the tag's own
  annotation summary (first line of `git tag -l -n1 <tag>`'s message,
  i.e. the annotated tag's subject) for an annotated tag, or, for a
  lightweight tag, the pointed-to commit's own subject line. A tag with
  neither (an annotated tag with an empty message) uses the literal text
  `(no title)`.
- **(decision)** Every writing subcommand (`git-release-squash apply`,
  `git-release-squash tail`, `git-history-rewrite replace`, `git-history-rewrite
  add-file`) is a dry run unless `--apply` is given (D1's shared rule,
  applied uniformly): without `--apply` it prints exactly the same report
  it would with `--apply`, changes no ref, creates no bundle, and exits 0.
  `git-release-squash plan` has no writing mode at all; giving it `--apply` is
  a usage error (exit 2).
- **(D2)** A dry run writes no git objects either, not just no ref: every
  hash a dry run's report needs (a would-be commit's sha, a would-be
  tree) is computed without `-w` (`git hash-object`, `git commit-tree`
  without writing) and a would-be tree is built with
  `git mktree --missing`, never `git write-tree` against a real index. A
  dry run leaves `.git/objects` byte-identical to before it ran, for
  every subcommand including `git-history-rewrite` (whose `--hook`, § 3.1, is
  still invoked during a dry run's tree computation -- the hook itself may
  write objects, but the dry run's OWN rule-rewriting and preview work
  never does).
- **(decision)** `--dates=anon|keep` is accepted by `git-release-squash apply`
  and `tail` (not by `plan`, which never writes and so never assigns
  dates); default `anon`. An unrecognised value is a usage error.
- A repository with **any merge commit** reachable from HEAD is refused by
  every `git-release-squash` subcommand (`plan`, `apply`, `tail`) and by every
  `git-history-rewrite` subcommand: `<bin>: merge commits are not supported
  (<short-sha>)`, naming the first merge commit found in `git log --topo-order`
  order. `git-leak-scan scan` has no such restriction (reading history never
  needs a linear one).

## 1. git-release-squash (`bin/git-release-squash`)

### 1.1 `plan <repo> [--name=<name>]`

Read-only. For every annotated or lightweight tag reachable from HEAD, in
tag-commit topological order (oldest first; two tags on the same commit are
both printed, in `git for-each-ref`'s own ordering, immediately adjacent),
prints two lines:

```
plan: <tag> folds <N> commit(s) (<oldest-short>..<tag-short>) into "<subject>"
plan: <tag> tree equals <tag-short>'s own tree: OK
```

`<oldest-short>` is the real, already-existing short sha of the oldest
commit this tag folds. `<tag-short>` is **not** the tag's own current
commit sha -- it is a *preview* short sha for the new squash commit,
computed the same way `apply` would build it (same tree/parent-chain/
subject/date rules as § 1.2) but without writing or signing anything.
Because `apply --apply`'s real commit is GPG-signed and the signature is
embedded in the commit object itself, the sha `apply` actually writes
necessarily differs from `plan`'s unsigned preview -- `<tag-short>` is
informational (and internally consistent between `plan`'s own two lines
for the same tag), not a value a caller can expect to see again once
`apply` runs.

`<N>` counts every commit reachable from `<tag>`'s commit that is not
reachable from the previous tag in the sequence (the first tag's `<N>`
counts from the root). The second line is always `OK` for an unmodified
repository — `plan` computes the same squash-commit tree git-release-squash
`apply` would write and compares it to the tag's own commit tree; the two
are equal by construction for any repo `plan` can walk, since the squash is
a reduction of commits whose net tree is, by definition, the tagged
commit's own tree. (A `FAIL` here is only reachable by `apply`/`tail`
re-verifying after a real rewrite — see § 1.4 — not by `plan` itself, which
cannot have written anything to disagree with; `plan` nonetheless always
prints the line, for a stable, diffable output shape across subcommands.)

After the last tag, if any commits reachable from HEAD are not reachable
from any tag (the untagged tail), one final line:

```
plan: N untagged commit(s) after <last-tag> are not covered by plan (see 'tail')
```

Exit 0 whenever the walk completes (dirty working tree does not matter —
`plan` never writes, so it tolerates one). Refuses on a merge commit (§ 0).
A repo with zero tags prints only the untagged-tail line (`after <root>`
reads as `from the root commit`, i.e. the line becomes `plan: N untagged
commit(s) from the start of history are not covered by plan`).

### 1.2 `apply <repo> --map <file> [--name=<name>] [--dates=anon|keep] [--apply]`

Refuses if HEAD is not itself on a tag (every commit through HEAD must
already belong to some tag; an untagged tail is what `tail` is for):
`git-release-squash: HEAD is not tagged -- run 'tail' first`. Refuses on a merge
commit, and (only when `--apply` is given — the writing form) on a dirty
working tree: `git-release-squash: working tree is dirty`. A dry run (no
`--apply`) tolerates a dirty tree, exactly like `plan`.

Without `--apply`: prints the same two-line-per-tag report `plan` prints
(identical format), then one line `git-release-squash: dry run, no ref changed
(use --apply to write)`, exits 0, writes nothing — no map file either,
even though `--map` was given (a dry run never writes *any* file).

With `--apply`:
1. Creates the backup bundle (§ 4.1) before changing anything.
2. Rewrites `refs/heads/<branch>` (whichever branch HEAD is on; a detached
   HEAD is a refusal, `git-release-squash: HEAD is detached`) so that history
   becomes exactly one commit per tag, oldest first, each parented on the
   previous squash commit (the first has no parent). Each new commit's
   tree is the original tag commit's own tree, byte-identical. Subject is
   `<name> <tag>: <title>` (§ 0). Dates per `--dates` (§ 4.3). Every
   original tag is re-pointed at its new squash commit, keeping its own
   name, type (lightweight stays lightweight, annotated stays annotated)
   and message; an annotated tag's tagger date follows the same
   `--dates` rule as commits.
3. Writes `<file>` (the `--map` argument): one line per **original**
   commit that existed before the rewrite, `<old-full-sha> <tag>`, in no
   particular required order, covering every original commit including
   the tag commits themselves (a tag spanning 5 folded commits produces 5
   map lines, all naming that one tag).
4. Runs verification (§ 4.2) and prints its report.
5. Exits 0 if the rewrite and verification both succeeded; exits 1 (after
   the rewrite has already happened — this is not a refusal, the write is
   real) if verification found a problem, naming which check failed.

### 1.3 `tail <repo> [--name=<name>] [--dates=anon|keep] [--tag=<tag> (--message=<text>|--message-file=<path>)] [--apply]`

Squashes only the commits reachable from HEAD that are not reachable from
any tag (the untagged tail) into exactly one new commit, parented on the
last tag's commit (or parentless, if there are no tags at all). Refuses if
there is no untagged tail (HEAD is itself already tagged):
`git-release-squash: HEAD is already tagged, nothing to squash`. Refuses on a merge
commit and, when `--apply` is given, on a dirty tree (same as `apply`).
Unlike `apply`, `tail` does **not** require any existing tag (a brand-new
repo with zero tags and an untagged HEAD squashes its whole history into
one commit) and does **not** itself create a tag for the new commit — that
is a separate, manual step outside this tool's scope (D1 only names
`plan`/`apply`/`tail`, no `tag` subcommand).

Without `--apply`: prints `tail: squashes <N> commit(s) (<oldest-short>..
<head-short>) into "<subject>"` then `git-release-squash: dry run, no ref changed
(use --apply to write)`, exits 0, writes nothing.

With `--apply`: creates the backup bundle, rewrites the branch HEAD is on
so the untagged tail becomes one commit (tree identical to the original
HEAD's tree, by the same tree-equality reasoning as § 1.1), subject
`<name> (untagged): <title>` (**decision**: no tag name exists yet to put
in the template, so the literal string `(untagged)` takes that slot;
`<title>` is HEAD's own commit subject), dated per `--dates`. No map file
is written by `tail` (there is no `--map` flag on this subcommand; giving
one is a usage error) — `tail`'s output is a single new commit, not a
tag-to-commits mapping. Runs verification (§ 4.2) except the "every commit
is tagged" check, which does not apply to an intentionally-untagged
result; prints its report; exits 0/1 the same way `apply` does.

**`--tag=<tag>` -- the one-step anonymous release (D2).** Without `--tag`,
`tail` behaves exactly as above (an `(untagged)` staging commit). With
`--tag=<tag>`, `tail` finishes a full, anonymous release in one call
instead of leaving a manual `git tag -s` for afterwards (a manual tag
afterwards would carry the real tagger date and the real signature time,
defeating the anonymisation `--dates=anon` exists for):

- `--tag` requires exactly one of `--message=<text>` or
  `--message-file=<path>` (the file's full contents, read as-is); giving
  neither, or both, is a usage error, exit 2. Giving `--message` or
  `--message-file` WITHOUT `--tag` is also a usage error -- both flags only
  mean something in a `--tag` release.
- The new commit's subject is `<name> <tag>: <title>`, where `<title>` is
  the first line of the message (not the untagged form's "HEAD's own
  commit subject" -- the message the caller just gave is the title).
- `tail` creates an annotated, signed tag `<tag>` on the new commit. The
  tag's own message is the message text in full (not just the first
  line). The tagger date follows `--dates`: under `anon` (the default) it
  is the exact same instant as the commit's own author/committer date;
  under `keep` it is the real time the tag is created. The signature time
  is pinned the same way as for commits (§ 0 / D1: the signing key's
  creation time + 60s via `--faked-system-time`), regardless of `--dates`.
- Refuses, before writing anything (dry run or `--apply` alike, same as
  the "HEAD is not tagged"/"already tagged" preconditions elsewhere), if
  `<tag>` already exists: `git-release-squash: tag <tag> already exists`.
- Without `--apply`, the usual dry-run report and line are printed and
  nothing is written, same as the untagged form; the planned tag name and
  title appear in the report line in place of `(untagged)`.

## 2. git-leak-scan (`bin/git-leak-scan`)

### 2.1 `scan <repo> [--terms <file>] [--allow <file>]`

Searches every blob reachable from any ref, every commit message, every
annotated tag message, and every author/committer/tagger identity line
(name and email) for:

- **email**: an RFC 5322-shaped local@domain address;
- **url**: an `http://` or `https://` URL;
- **local-path**: an absolute path under `/Users/`, `/home/`, or
  `C:\Users\`;
- **hostname**: a dotted hostname containing at least one of
  `.local`, `.internal`, `.corp`, `.lan`;
- **ip**: an IPv4 dotted-quad (not `127.0.0.1` or `0.0.0.0`, which are not
  flagged — **decision**, those two are never a leak);
- **secret**: a PEM private-key header (`-----BEGIN ... PRIVATE KEY-----`)
  or a line matching `[A-Za-z0-9_-]{20,}` immediately preceded by one of
  `token=`, `secret=`, `key=`, `password=` (case-insensitive, no space
  before `=`).

The repo's own author identity is reported like any other email;
allowlist it explicitly if it is meant to be public.

Plus, when `--terms <file>` is given, one category **term** per
case-insensitive literal line of that file (blank lines and lines starting
with `#` are skipped), matched as a plain substring anywhere in the same
blobs/messages/identities.

Binary blobs (`git diff --no-index` convention: contains a NUL within the
first 8000 bytes) are not scanned for text categories but are still hashed
and reported under category **secret** if they look like a PEM/PKCS#8 key
file by content regardless of the NUL check (so an actual binary-encoded
key is not accidentally skipped only because it fails the UTF-8 shaped
checks the rest of this command makes).

Each hit is one stdout line:

```
scan: <category> <match> (<count>) first at <short-sha>:<path>
```

`<match>` is the exact matched text (an email, a URL, …) with no
normalisation; `<count>` is the number of DISTINCT (commit, path) pairs the
same exact match was found in (a match repeated verbatim across 40 commits
of the same unmodified file counts 40, not 1 — every reachable blob is
scanned, including ones identical to an ancestor's). For a hit in a commit
message, tag message, or identity line (no path), `<path>` is the literal
string `(message)`, `(tag-message)`, or `(identity)` respectively.

`--allow <file>`: one exact `<match>` string per line (blank/`#` lines
skipped); any hit whose `<match>` equals a line in this file, verbatim, is
suppressed entirely (not printed, not counted towards the exit code).

Exit 0 when zero hits remain after allowlisting; exit 1 when at least one
hit remains (hits are still all printed before exiting 1); exit 2 on a
usage error (bad flag, `--terms`/`--allow` file does not exist). Refuses
(exit 1, no scanning performed) if `--terms` or `--allow` resolves to a
path inside `<repo>` (§ 4.4) — printed before any hit, as the sole output
line.

## 3. git-history-rewrite (`bin/git-history-rewrite`)

### 3.1 `replace <repo> --rules <file> [--hook <script>] [--apply]`

`<file>`: ordered lines, `from<TAB>to` (a literal tab byte separates the
two columns; `to` may be empty, meaning "delete `from`"; a line without a
tab, or with more than one tab, is a usage error naming the line number).
Blank lines and lines starting with `#` are skipped. Order matters: rules
apply in file order, each to the **output of the previous rule**, within
every text blob (a rule's `from` can match text a prior rule introduced).

A blob is text (eligible for replacement) by the same NUL-within-8000-bytes
convention as § 2.1; a binary blob is copied byte-for-byte into the new
tree, untouched, even if it contains a byte sequence equal to some rule's
`from` read as bytes. A text blob with no trailing newline keeps having no
trailing newline (a rule is never allowed to add or remove exactly one
trailing newline as a side effect of the last replacement in the file —
**decision**: trailing-newline presence is tracked separately from content
and reapplied after all rules run).

Refuses (before writing anything) if applying every rule, in order, to any
commit's message, or to any annotated tag's message, would change that
message's text: `git-history-rewrite: commit <short-sha> message would change --
replace only rewrites file contents` (or `tag <tag>` for a tag message).
This is checked for every commit/tag up front, before any blob is
rewritten, so the refusal is exit 1 with the repo fully unchanged, not a
partial rewrite.

`--hook <script>`: after rules are applied to produce a new root tree for
a commit, `<script>` is run once per **distinct resulting root tree**
(a tree identical to one already processed is not re-run), with that
tree's 40-hex sha as its sole argument and `GHT_REPO=<repo>` in its
environment. If it prints a 40-hex sha to stdout (one line, nothing else)
that sha is used as the commit's tree instead of the rule-rewritten one;
if it prints nothing (exit 0, empty stdout) the rule-rewritten tree is
kept unchanged; any other stdout shape, or a non-zero exit, is a refusal
naming the hook and its exit status/output, repo left unchanged.

Without `--apply`: prints one line per commit that would change,
`replace: <short-sha> would change`, then a summary line `replace: N of M
commits would change`, then `git-history-rewrite: dry run, no ref changed (use
--apply to write)`; exits 0; writes nothing (including: the hook, if
given, is still invoked during the dry run's tree computation, since
knowing which commits "would change" requires computing the would-be
trees — but no ref moves and no bundle is created).

With `--apply`: creates the backup bundle, rewrites every ref (branches
and tags) to point at the rewritten history; tag names, messages, and
types are kept; an annotated tag is re-signed, dated at its own (kept, not
anonymised — § 0 lists dates as untouched by `replace`/`add-file`, only
`git-release-squash` anonymises) original tagger date. Runs verification
(§ 4.2) with the replace-specific fourth check (§ 4.5); prints its report;
exits 0/1 the same way `git-release-squash apply` does.

### 3.2 `add-file <repo> <path> [--as <repo-path>] [--apply]`

`<path>`: a file on disk (outside the repo or inside it, either is fine —
unlike `--rules`/`--terms`/`--allow`, this file is meant to end up
committed, so § 4.4's warning/refusal does not apply to it). `--as`:
the path the file is written to inside every commit's tree; default is
`<path>`'s own basename.

Every commit's tree gets (or keeps, if already present with different
content) a blob at `<repo-path>` whose bytes and mode (`100644` unless
`<path>` on disk is executable, then `100755`) exactly match `<path>` on
disk, at the moment `add-file` runs (one fixed snapshot, not re-read per
commit). A commit that already has a blob at `<repo-path>` has it
replaced; a directory already at `<repo-path>` is a refusal (naming the
first such commit), not silently overwritten.

Dry run / `--apply` reporting, backup bundle, verification and exit codes
follow `replace`'s own shape exactly (§ 3.1), substituting "would add/
replace `<repo-path>`" for "would change" in the per-commit line.

## 4. Shared mechanics

### 4.1 Backup bundle

`--apply` on any writing subcommand creates
`<parent-of-repo>/<repo-basename>.backup-<UTC>.bundle` (`git bundle create
... --all`, capturing every ref as it stood immediately before any rewrite)
before touching a single ref. `<UTC>` is `YYYYMMDDTHHMMSSZ` (e.g.
`20261010T021500Z`), the wall-clock instant the tool is invoked. The
bundle's existence and `git bundle verify`-cleanliness are asserted by
tests; its exact byte content is not (bundles are not reproducible byte
output, only a restorable snapshot).

### 4.2 Verification

After every `--apply` write (never during a dry run, which has nothing to
verify), in this order, each printed as `verify: <check>: OK` or `verify:
<check>: FAILED (<reason>)`:

1. `tree delta` — every ref's tree, post-rewrite, exactly equals the
   corresponding pre-rewrite tree it is supposed to preserve (the tagged
   commit's tree for squash, the rule-rewritten tree for replace/add-file)
   — nothing else changed.
2. `signatures` — every commit and annotated tag reachable from any local
   branch or tag (`refs/heads/*`, `refs/tags/*` -- **not**
   `refs/remotes/*`, which `apply`/`tail`/`replace`/`add-file` never touch
   and may still point at pre-rewrite history) has a signature `git
   verify-commit`/`git verify-tag` accepts.
3. `squash: every commit tagged` — (git-release-squash `apply` only; skipped,
   not printed, for `tail`/`replace`/`add-file`) every commit reachable
   from HEAD has at least one tag pointing at it.
4. `replace: rule sources clean` — (git-history-rewrite `replace` only;
   skipped for `add-file`/git-release-squash) a git-leak-scan (§ 2.1, built-in
   categories only, no `--terms`/`--allow`) of the **values on the right-
   hand side of `--rules`** (the chosen replacement text, one synthetic
   "blob" per rule, not the left-hand `from` text, and not the file's own
   path) finds 0 hits — catching a replacement that swaps one leak for
   another.

### 4.3 Anonymous dates

`--dates=anon` (default): commit `i` (**1-based**, oldest first, across the
whole rewritten history) gets author and committer date exactly
`1970-01-(i+1) 12:00:00 +0000` -- the root commit is `i=1`, so it lands on
1970-01-02 12:00:00 +0000, not 1970-01-01 (D1, commit bd16ac2: matches the
already-published nanojira history's own `@<i*86400+43200> +0000`
convention). An annotated tag's tagger date is the same instant as the
commit it now points to. `--dates=keep`: every date (author, committer,
tagger) is copied byte-for-byte from the original commit/tag.
`git-history-rewrite` never anonymises dates regardless of flags (§ 3.1): the
`--dates` flag belongs to `git-release-squash` only; giving it to
`git-history-rewrite` is a usage error.

`tail` keeps every EXISTING commit's date unchanged (it only squashes the
untagged tail into one new commit — § 1.3's own dating already follows
this: the new commit is simply the next position in the result). Each new
commit `tail` or `apply` writes gets the anon date for its own position in
the RESULTING history, not the position it would have had if dated in
isolation -- so a history squashed to tag v1 in one `apply` run, then
later extended with `tail`, ends up with exactly the same per-commit
dates (and tree, and subjects) as if the whole thing had been squashed in
a single run up front. AC-35 is the acceptance test for this equivalence.

### 4.4 Rules/terms files must live outside the repo

Before doing anything else, every subcommand that accepts `--rules`,
`--terms` or `--allow` resolves that path to an absolute, symlink-resolved
real path and checks whether it is inside `<repo>`'s own resolved real
path. If it is: refusal, exit 1, one stderr line naming the flag and the
path, before any scan or rewrite work happens: `<bin>: --rules points
inside the repo (<path>) -- keep it outside` (substituting `--terms`/
`--allow` as appropriate). **(decision, reconciling D1's "warn" with this
spec's own refuse-on-every-precondition-violation convention)**: this is
a hard refusal like every other precondition in § 0, not merely a printed
warning that still proceeds — a rules/terms file that lives inside the
repo would otherwise get committed the next time the repo's own history
is rewritten, which is exactly the leak this whole tool exists to prevent.

## 5. Acceptance criteria

One test file per criterion, `test/ac/ac-NN-<slug>.ts`, run via
`node test/run-all.ts` (defaults to `bin/` next to `test/`; an explicit
path may be given as `argv[2]`). Every file reports `CANNOT RUN` (not a
failure) if the binary it needs does not exist yet — the oracle is
written before the implementation.

| AC | File | Covers |
|----|------|--------|
| AC-01 | ac-01-squash-plan-basic.ts | `plan`: per-tag lines, tree-equality OK, a tag on the root commit |
| AC-02 | ac-02-squash-plan-two-tags-one-commit.ts | `plan`: two tags on one commit, both printed; `apply --apply`: both tags re-point to the SAME new squash commit |
| AC-03 | ac-03-squash-plan-tag-types.ts | `plan`: lightweight and annotated tags both handled, consistent line shape |
| AC-04 | ac-04-squash-plan-untagged-tail.ts | `plan`: untagged tail reported, not folded |
| AC-05 | ac-05-squash-refuses-merge.ts | `plan`/`apply`/`tail` all refuse a merge commit |
| AC-06 | ac-06-squash-apply-refuses-dirty.ts | `apply --apply` refuses a dirty tree; dry run does not |
| AC-07 | ac-07-squash-apply-refuses-untagged-head.ts | `apply` refuses when HEAD is not tagged |
| AC-08 | ac-08-squash-apply-dry-run-no-refs-changed.ts | `apply` without `--apply` changes no ref |
| AC-09 | ac-09-squash-apply-creates-backup-bundle.ts | `apply --apply` creates the named, verifiable bundle first |
| AC-10 | ac-10-squash-apply-map-file.ts | `apply --apply`'s map file: one `<old-sha> <tag>` line per original commit |
| AC-11 | ac-11-squash-apply-anon-dates.ts | `--dates=anon`: exactly 1970-01-(i+1) 12:00:00 +0000, i 1-based |
| AC-12 | ac-12-squash-apply-keep-dates.ts | `--dates=keep`: original dates preserved byte-for-byte |
| AC-13 | ac-13-squash-apply-verification-signatures.ts | post-rewrite signature verification passes for every commit/tag |
| AC-14 | ac-14-squash-apply-verification-every-commit-tagged.ts | post-rewrite "every commit tagged" check |
| AC-15 | ac-15-squash-tail-basic.ts | `tail`: squashes only the untagged tail into one commit |
| AC-16 | ac-16-squash-tail-refuses-no-tail.ts | `tail` refuses when HEAD is already tagged |
| AC-17 | ac-17-squash-tail-no-tags-yet.ts | `tail` on a repo with zero tags squashes everything, no refusal |
| AC-18 | ac-18-scan-basic-categories.ts | `scan`: email/URL/local-path/hostname/IP/secret hits, one line per hit, exit 0/1 |
| AC-19 | ac-19-scan-hit-in-tag-message.ts | `scan`: a hit only inside an annotated tag's own message |
| AC-20 | ac-20-scan-hit-in-author-email.ts | `scan`: a hit only inside a commit author's identity line |
| AC-21 | ac-21-scan-terms-file.ts | `scan --terms`: custom case-insensitive terms |
| AC-22 | ac-22-scan-allowlist.ts | `scan --allow`: suppresses an exact known-good match |
| AC-23 | ac-23-scan-usage-errors.ts | `scan`: bad flag / missing file is exit 2, not 1 |
| AC-24 | ac-24-rewrite-replace-order-matters.ts | `replace`: rules apply in file order, each on the previous rule's output |
| AC-25 | ac-25-rewrite-replace-binary-untouched.ts | `replace`: a binary blob is byte-identical after rewrite |
| AC-26 | ac-26-rewrite-replace-no-trailing-newline.ts | `replace`: a file with no trailing newline keeps none |
| AC-27 | ac-27-rewrite-replace-refuses-message-change.ts | `replace`: refuses when a commit message would change |
| AC-28 | ac-28-rewrite-replace-refuses-tag-message-change.ts | `replace`: refuses when a tag message would change |
| AC-29 | ac-29-rewrite-refuses-rules-inside-repo.ts | `replace`/`scan`: refuses a `--rules`/`--terms`/`--allow` path inside `<repo>` |
| AC-30 | ac-30-rewrite-add-file-existing.ts | `add-file`: replaces an existing blob at the target path in some commits |
| AC-31 | ac-31-rewrite-dry-run-no-refs-changed.ts | `replace`/`add-file` without `--apply` changes no ref |
| AC-32 | ac-32-rewrite-apply-creates-backup-bundle.ts | `replace --apply` creates the backup bundle |
| AC-33 | ac-33-rewrite-verification-rule-sources-clean.ts | post-rewrite "rule sources clean" git-leak-scan check |
| AC-34 | ac-34-rewrite-replace-hook.ts | `--hook`: receives the tree sha, its printed sha overrides the tree |
| AC-35 | ac-35-squash-tail-continues-dates.ts | `apply` then `tail` later equals one `apply`/`tail` run: same tree, dates and subjects, commit by commit |
| AC-36 | ac-36-squash-tail-tag-release.ts | `tail --tag --message`: subject/tag/tagger-date/signature, usage errors, refuses an existing tag |
| AC-37 | ac-37-squash-tail-tag-vs-apply-equivalence.ts | one `apply` over pre-tagged releases equals `tail --tag` run release by release: same subjects and dates per commit |
| AC-38 | ac-38-squash-dry-run-writes-no-objects.ts | `plan`/`apply`/`tail` dry runs leave `.git/objects` byte-identical |
| AC-39 | ac-39-rewrite-dry-run-writes-no-objects.ts | `replace`/`add-file` dry runs leave `.git/objects` byte-identical |
| AC-40 | ac-40-harness-cleanup-leaves-tmp-root-empty.ts | harness hygiene: backup bundles are cleaned up too; a run leaves 0 entries in a fresh tmp root |
