# Specification — git-history-tools v0.4

This is the precise CLI contract. docs/DECISIONS.md D1 is the scope and shape;
this document pins the exact arguments, output lines, exit codes and refusals
a black-box test can assert on. Where D1 left a choice open, the choice made
here is marked **(decision)** and is binding — a test encodes it, and an
implementation that disagrees is wrong, not the test.

## 0. Conventions

- Layout: `SKILL.md`, `bin/git-release-squash`, `bin/git-leak-scan`, `bin/git-history-rewrite`,
  `bin/git-sign` (POSIX `sh` wrappers that resolve their own path through
  any symlinks, then `exec node "<dir>/../lib/<name>.ts" "$@"`, D6),
  `lib/*.ts`. Node.js ≥ 24, no runtime dependencies (D1).
- Every tool is invoked as `<bin> <subcommand> [args...]`. An unknown
  subcommand, a missing required argument, or an unknown flag is a **usage
  error**: exit 2, one line on stderr, `<bin-basename>: <reason>` (e.g.
  `git-release-squash: unknown subcommand 'plna'`), nothing on stdout.
- A value flag takes its value as `--flag=<value>` or as the next argument
  (`--flag <value>`); in the space-separated form, a next argument that
  itself starts with `--` is never taken as the value — `--message --apply`
  is the usage error `<bin>: missing value for --message` rather than a
  message reading "--apply" and a silently dropped `--apply` (D17). A value
  that really starts with `--` is passed as `--flag=--value`.
- git-sign alone has a help form (§ 5): `git-sign --help`/`-h`/`help` prints
  the synopsis of every subcommand on stdout, exit 0; `git-sign <sub>
  --help` (or `-h`) prints `usage: <that synopsis>`, exit 0; no subcommand
  at all is a usage error whose `git-sign: missing subcommand` line is
  followed by the same synopses on stderr (D17).
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
  add-file`, `git-sign commit`/`tag`/`resign-tags`/`resign-commits`) is a dry
  run unless `--apply` is given (D1's shared rule,
  applied uniformly): without `--apply` it prints exactly the same report
  it would with `--apply` (git-sign's minus the new shas, which a dry run
  cannot know, § 5.1/§ 5.5), changes no ref, creates no bundle, and exits 0.
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

**Restore recipe (D14, tested).** `git fetch <bundle> 'refs/*:refs/*'` is
refused outright while the repo's HEAD is checked out on a branch the
fetch would overwrite (`fatal: refusing to fetch into branch '<ref>'
checked out at '<path>'`) — detach HEAD first:

```
git -C <repo> checkout --detach HEAD
git -C <repo> fetch <bundle-path> 'refs/*:refs/*' --force
git -C <repo> checkout <branch-you-want>   # re-attach HEAD somewhere sane
```

This restores every ref the bundle captured (every branch and tag, since
it was created with `--all`) to exactly its pre-rewrite state, in place,
in the SAME repo. To inspect the bundle's contents instead, without
touching the live repo at all: `git clone --mirror <bundle-path>
<scratch-dir>` works with no detach needed (a fresh clone has no
checked-out branch to conflict with) — but pushing FROM that mirror INTO
the original repo hits the identical "checked out branch" refusal from
the receiving end (`remote: error: refusing to update checked out
branch`), so restoring in place is still the fetch-after-detach recipe
above, not a push from a mirror.

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

## 5. git-sign (`bin/git-sign`)

Unlike the other three tools, git-sign never reads or writes `user.signingkey`,
`user.name`/`user.email` in `<repo>`'s own git config (D8), and never reads
`gpg.program` from ANY git config — repo, global, system or
`GIT_CONFIG_*` (D17): identity, the signing key and the gpg binary all come
from the **policy file** (below; the gpg binary is its optional
`gpgProgram`, default `gpg` from `PATH`). They reach git only as
`GIT_AUTHOR_*`/`GIT_COMMITTER_*` environment variables, `-c
user.signingkey=<key>` / `-c gpg.program=<wrapper>` on the one invocation that
signs, and a `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_<n>`/`GIT_CONFIG_VALUE_<n>`
override of `gpg.program` on every `git verify-commit`/`verify-tag`/`tag -v`
git-sign runs, so a repo's own `gpg.program` is never executed — nothing
persists in `<repo>/.git/config`.

Synopses (`git-sign --help`, § 0):

```
git-sign commit <repo> (--message=<text>|--message-file=<path>) --date=(auto|<date>) [--amend] [--policy=<file>] [--apply]
git-sign tag <repo> <tag> (--message=<text>|--message-file=<path>) --date=(auto|<date>) [--policy=<file>] [--apply]
git-sign resign-tags <repo> [<tag> ...] [--policy=<file>] [--apply]
git-sign resign-commits <repo> (<lower>..<upper> | <rev> --from-root) [--map-out=<file>] [--policy=<file>] [--apply]
git-sign check <repo> [<range> | --range=<range>] [--tags] [--policy=<file>]
```

### 5.0 The policy file

A JSON file, resolved in this order: `--policy=<file>`, else
`$XDG_CONFIG_HOME/git-history-tools/policy.json`, else
`$HOME/.config/git-history-tools/policy.json`. It must live outside `<repo>`
(§ 4.4's rule, reused as-is). A missing, unreadable, non-JSON, or
schema-invalid policy is a **refusal** naming the file and the specific
problem — never a usage error, since the default location legitimately may
not exist yet and this is a repo-independent precondition, not a CLI mistake.

Schema (every key required except `anonymousBefore` and `gpgProgram`, no unknown key
accepted anywhere in the document — a typo is a refusal, not a silently
ignored key):

```json
{
  "identity": { "name": "Your Name", "email": "you@example.com" },
  "signingKey": "0123456789ABCDEF0123456789ABCDEF01234567",
  "timezone": "Europe/Berlin",
  "forbiddenWindows": [
    { "days": ["mon", "tue", "wed", "thu", "fri"], "from": "07:00", "to": "19:00" }
  ],
  "forbiddenMessagePatterns": [
    "Co-Authored-By: Claude",
    "Generated with \\[Claude Code\\]",
    "noreply@anthropic\\.com"
  ],
  "anonymousBefore": "1971-01-01T00:00:00Z"
}
```

- `identity.name`/`identity.email`: non-empty strings.
- `signingKey`: a 16-40 character hex key id/fingerprint.
- `timezone`: an IANA zone name valid for `Intl.DateTimeFormat`. Every
  forbidden-window and forbidden-instant check below is evaluated in this
  zone (DST-aware), regardless of any offset embedded in a git timestamp
  being checked — a UTC+2 commit timestamp is still checked against the
  policy's own Europe/Berlin wall-clock time, not its own recorded offset.
- `forbiddenWindows`: an array (may be empty) of `{days, from, to}`; `days`
  is a non-empty array of distinct `mon`/`tue`/`wed`/`thu`/`fri`/`sat`/`sun`;
  `from`/`to` are `HH:MM`, `from` strictly before `to`. An instant is
  forbidden when its zoned weekday is in some window's `days` and its zoned
  `HH:MM` falls in `[from, to)`. A window cannot span midnight: split
  `22:00`–`06:00` into two windows (`22:00`–`23:59` on the first day,
  `00:00`–`06:00` on the next). Since `to` is exclusive and at most `23:59`,
  the minute 23:59 itself is never forbidden.
- `forbiddenMessagePatterns`: an array (may be empty) of strings, each a
  JavaScript regular expression source (`new RegExp(pattern, 'i')` —
  **case-insensitive**, so a policy author does not have to anticipate
  every casing variant by hand; GitHub's own trailer is lowercase
  `Co-authored-by:`, a different case from the example above — escape
  metacharacters that are meant literally, as `\\[`/`\\]` above). A regex
  that fails to compile is a policy refusal at load time, naming the bad
  pattern, not a later surprise mid-command.
- `anonymousBefore` (optional): an ISO date string. An author/committer/
  tagger date strictly before it is exempt from the `forbiddenWindows`
  check ONLY — git-release-squash's own anonymous placeholder dates (e.g.
  `1970-01-26 12:00:00 +0000`) are not real working hours, and `check`
  would otherwise flag every single one. Identity and message are never
  exempt. The signature's own creation time (§ 5.4's `sig-time`) is never
  simply skipped either — an anonymised object's signature is always made
  in real time — but it switches from the window rule to the stricter D1
  pin-exactness rule (§ 5.4, D10). Omitted: exempts nothing (and `sig-time`
  always uses the window rule).
- `gpgProgram` (optional, D17): the gpg binary every git-sign command runs
  — for signing and for every verification, including the gpg that git's
  own `verify-commit`/`verify-tag`/`tag -v` start on git-sign's behalf.
  An absolute path to an existing, executable regular file; anything else
  is a refusal naming the problem (`'gpgProgram' must be an absolute path
  (got <json>)`, `does not exist: <p>`, `is not a file: <p>`, `is not
  executable: <p>`). Omitted: `gpg` from `PATH`. `gpg.program` in git
  config is never consulted either way (§ 5).

### 5.1 `commit <repo> (--message=<text>|--message-file=<path>) --date=(auto|<date>) [--amend] [--policy=<file>] [--apply]`

Commits the current index (exactly what `git commit` would commit) with the
policy's identity, signed by the policy's key, dated per `--date`.
`--message-file=-` reads stdin. Refuses, before anything is written, in this
order: the message matches a `forbiddenMessagePatterns` entry (naming it);
the resolved `--date` falls in a forbidden window, or is not strictly after
the parent commit's own committer date (`is not after the parent's
committer date (<date>)`; the current HEAD, or — with
`--amend` — HEAD's own parent, since amending replaces HEAD and its real
parent becomes HEAD^; either may not exist, for an initial commit or an
amended root commit, in which case there is no lower bound at all).

`--date=<date>`: `YYYY-MM-DD[T ]HH:MM[:SS]` optionally followed by `Z` or a
`+HH:MM`/`+HHMM` offset; without an offset, the wall-clock time is read in
the policy's own timezone — and if that wall-clock time does not exist
(a spring-forward DST gap) or occurs twice (a fall-back repeated hour),
a refusal naming the time, the zone, and the candidate offset(s), rather
than silently shifting by an hour or picking one arbitrarily (D12); give
an explicit offset to sidestep the zone lookup entirely. `--date=auto`:
the latest allowed minute at or before now, strictly after the lower
bound above; if none exists in that range — the whole gap is one
forbidden window, or the lower bound itself lies within the current
minute (e.g. `tag --date=auto` right after a `commit --date=auto` in the
same minute) — a refusal naming the next allowed minute instead of
silently picking something later than "now"; wait for it or pass an
explicit `--date`.

The **signature time** (`signTimeFor`, `lib/policy.ts`, shared by every
signing command) is the chosen date itself, UNLESS that predates the
signing key's own creation, in which case it is clamped up to the first
policy-ALLOWED minute at or after `created + 60s` — never the raw
`created + 60s` instant itself, which can itself fall inside a forbidden
window (D1's original rule, generalized twice: first to the later of the
chosen date and `created + 60s`, since an anonymised-1970 commit and a
real dated one need different floors; then, D13, from the raw pin to the
first allowed minute at or after it, so the clamp itself can never
produce a `check` violation). A date exempted by `anonymousBefore` is
pinned to `created + 60s` EXACTLY instead (D10), unaffected by D13.

Without `--apply`: prints the resolved identity, date (with its zone
offset), key, and signature time; exits 0; writes nothing — not even a
preview commit sha (unlike squash/rewrite's `plan`, there is no no-write
form of `commit-tree`/`git commit`, so a dry run honestly cannot show one;
D2's actual requirement, no objects written, still holds).

With `--apply`: creates the commit (via `git commit [--amend] -S
--author=<name> <email> --date=<date>`, env vars carrying the same values —
`--author`/`--date` are passed explicitly on the command line, not only as
env vars, because `git commit --amend` otherwise silently keeps the
*original* commit's author name/email/date regardless of
`GIT_AUTHOR_*` **(decision)**); prints the same resolved-values report plus
`sign: commit <short-sha>`.

### 5.2 `tag <repo> <tag> (--message=<text>|--message-file=<path>) --date=(auto|<date>) [--policy=<file>] [--apply]`

Same message/date/signature-time rules as `commit` § 5.1, targeting HEAD
(the lower bound for `--date`/`auto` is HEAD's own committer date, since a
tag has no parent chain of its own; the refusal says so: `is not after the
target's committer date (<date>)`). Refuses if `<tag>` already exists:
`git-sign: tag <tag> already exists -- use resign-tags to re-sign it`
(no `--force`; that is `resign-tags`'s job, § 5.3). Dry run / `--apply`
reporting follows `commit`'s shape, substituting `sign: tag <tag>` for
`sign: commit <sha>`.

### 5.3 `resign-tags <repo> [<tag> ...] [--policy=<file>] [--apply]`

Re-signs annotated tags, changing nothing but the signature. Without
`<tag>` arguments: every annotated tag NOT already validly signed by
`policy.signingKey` (idempotent — a second run with no arguments finds
nothing left to fix). With one or more `<tag>` arguments: exactly those
tags, even if already validly signed by the policy key. A lightweight tag,
named explicitly or reached by the default selection, is skipped and
reported (`resign-tags: <tag> is lightweight, skipped`), never an error — it
has no signature to re-sign. A named tag that does not exist is a usage
error (exit 2), naming it.

With `--apply`: creates the backup bundle first (§ 4.1, reused); for each
selected tag, re-creates it with the identical target commit, tagger line
(name/email/date, byte-identical), and message — only the embedded signature
differs — at signature time per the shared `signTimeFor` rule (§ 5.1/D13):
the tagger date itself, or, if that predates the signing key, the first
policy-allowed minute at or after `created + 60s` (never the raw pin,
which could itself fall inside a forbidden window).

**(decision, D14 follow-up; D16/D18 revise the boundary)** The message
used to re-create a tag is read from the RAW object (`git cat-file -p`),
everything after the header's blank-line separator, truncated at the
boundary `tagSignatureBoundary` (siginfo.ts) finds if one follows — a
single backward walk from EOF that also answers `signatureBlockCount`'s
"how many" question, so there is no second, independent scan left
anywhere to disagree with it (D18; it replaces D16's own
`lastTagSignatureBeginIndex`/`stackedTagBlockCount` pair, which could
still disagree on an UNSIGNED tag whose message quotes a complete block
in the middle with real text after it — `lastTagSignatureBeginIndex`'s
bare `lastIndexOf` had no notion of "is this actually trailing the
object" and returned the quote's own position as a false boundary) —
NEVER `for-each-ref --format=%(contents)`, which for an ALREADY-SIGNED
tag includes the existing trailing signature block as part of its own
output (git's own documented behaviour). Feeding that straight back in as
the new tag's message embedded the OLD signature as literal text inside
the new one, which then received a second, genuinely new signature
appended right after it — a tag object with two concatenated signature
blocks (found resigning an already-signed tag, the single most common
real case: see AC-57). An unsigned tag whose message ENDS with a
complete quoted block — genuinely indistinguishable from a tag that IS
signed but whose signature gpg can neither verify nor attribute to any
key (§ 5.5's own ambiguity) — is refused outright (exit 1, naming the
tag) rather than guessed at, by this subcommand and by `resign-commits`'
own tag-on-tag path alike (D18). Afterwards, per tag:
`verify: <tag>: OK` / `FAILED (<reason>)`
(target unchanged; the tag object's bytes before the signature block
byte-identical; the new message independently byte-identical to the old
one — computed via a SEPARATE, regex-based method,
`independentOldTagMessage`, that cannot share a bug with the one walk
above, D18; the new object has EXACTLY ONE signature block, never 0 or
2+ — the defensive guard that would have caught the bug above on its own,
since the byte-identity check and `git tag -v` both happened to miss it;
`git tag -v` accepts the new signature by the policy key),
then `resign-tags: <tag> <old-sha> -> <new-sha>`, then a `#`-prefixed line
giving the exact command to push the change: `git push
--force-with-lease=refs/tags/<tag>:<old-sha> <remote> refs/tags/<tag>`
(`<remote>` is a literal placeholder — this tool never inspects or assumes a
remote, and never pushes, ever). A re-signed tag whose new object is
byte-identical to the old one (a deterministic signature scheme such as
EdDSA, re-signed at the same signature time) is reported `resign-tags:
<tag> <sha> -> <sha> (unchanged)` and gets no push line — nothing moved
(D17). Without `--apply`: lists lightweight skips
and `resign-tags: <tag> would be re-signed` per candidate; exits 0; writes
nothing. No candidates (and no explicit list): `git-sign: nothing to resign`,
exit 0.

### 5.4 `check <repo> [<range>] [--range=<range>] [--tags] [--policy=<file>]`

Read-only; writes nothing, ever (no `--apply`). `<range>` may be given
positionally or as `--range=<range>` (giving both is a usage error, exit 2
— § 0's "any further unexpected positional is a usage error" applies here
too: a third positional, beyond `<repo>` and `<range>`, is also exit 2).
Default, when neither is given, is `@{upstream}..HEAD`; no upstream
configured is a refusal naming `--range`/the positional form as the way out
(same silent-on-refusal shape as everywhere else in this spec — this is a
precondition failure, not the violations case below). For every commit in
`<range>` (and, with `--tags`, every annotated tag in the repo, regardless
of `<range>`), checks:

- **identity** — author (and, separately, committer/tagger) name+email
  exactly equal the policy's;
- **signature** — a valid signature (`git verify-commit`/`verify-tag --raw`'s
  `VALIDSIG` line) by `policy.signingKey` (fingerprint, or a suffix of it —
  gpg's own reported key-id length is not consistent across versions). The
  detail names which specific case: `missing` (no signature at all); `signed
  by unknown key <keyid> (not in keyring)` (`NO_PUBKEY` — the signing key
  isn't in the verifying keyring); `good signature but by <fingerprint>, not
  the policy key` (a cryptographically good signature, just not by
  `policy.signingKey`); `bad signature` (anything else gpg itself calls
  invalid); `multiple-signatures (<N> signature blocks found)` — checked
  BEFORE any of the other cases above, and never silently resolved by
  picking "the first" block found: `siginfo.ts`'s `extractSignature`
  refuses to hand such an object to gpg at all, and this case is reported
  on its own rather than falling through to `missing`. For a commit: 2+
  top-level `gpgsig`/`gpgsig-sha256` header lines, counted in the HEADER
  REGION ONLY (up to the first blank line) — never the whole object,
  which also includes the MESSAGE, where a line that happens to start
  with "gpgsig " as ordinary prose must not be miscounted as a second
  signature (D16, Lead-found). For a tag: not "2+ `-----BEGIN PGP
  SIGNATURE-----` markers anywhere in the object" (that over-fires on a
  message that legitimately QUOTES a signature block as literal text,
  e.g. pasting an old security advisory into a release tag) but 2+
  signature blocks STACKED back-to-back at the very end of the object —
  walking backward from EOF, each complete `BEGIN...END` block
  immediately preceded (modulo blank lines) by another complete block
  counts as one more layer (`tagSignatureBoundary`'s `count`, siginfo.ts —
  D18 unified this with the boundary-finding question itself, see § 5.1
  above). A quoted block followed by further real text before the real
  trailing signature does NOT count; a quoted block with nothing between
  it and the real signature is genuinely indistinguishable from the
  item-0 corruption shape and DOES still count (D16). Found as a
  follow-up to the message-extraction bug above — see AC-58 (the
  hand-constructed shape, independent of any one tool producing it),
  AC-61 (the quoted-block and message-prose false-positive cases D16's
  redefinition fixes), and AC-65 (the unsigned-tag boundary-disagreement
  bug D18 fixes, plus the ambiguous all-quote-no-text-after ending both
  tag-resigning paths now refuse on rather than guess);
- **date** — author and committer (or tagger) date outside every forbidden
  window, unless exempted by `anonymousBefore` (§ 5.0);
- **sig-time** — the signature's own creation time, for a signature the
  `signature` check above found `ok` — parsed from the signature PACKET's
  own `version <n>, created <epoch>,` field via `gpg --list-packets` (NOT
  the human-readable date on the hashed-subpacket annotation a few lines
  down — that is a date string, not an epoch), independent of trust state.
  A present signature whose creation time cannot be parsed is itself a
  violation (`signature creation time could not be read`), never silently
  treated as clean — this is what catches a leaked real-time signature on
  an otherwise-anonymised commit (D8/D9). The rule applied to that time
  depends on whether the object's own date (author/committer for a commit,
  tagger for a tag) is exempted by `anonymousBefore`: a real-dated object's
  signature must fall outside every forbidden window, exactly as above; an
  **anonymised** object's signature is never checked against the windows at
  all — by construction it is always pinned to `key creation + 60s` (D1),
  and that pin itself leaks nothing a public key doesn't already reveal —
  instead the signature time must equal that pin EXACTLY, anything else
  (including a real workday instant) being its own violation (`anonymous
  object not signed at the pinned time (expected <t1>, got <t2>)`, D10);
- **message** — free of every `forbiddenMessagePatterns` entry (matched
  case-insensitively, § 5.0).

Each hit is one stdout line, `<sha|tag> <rule> <detail>` (`rule` is one of
`identity`/`signature`/`date`/`sig-time`/`message`), followed by a summary
`check: <N> violation(s) across <M> commit(s)[ and <K> tag(s)]`. **(decision)**
Exit 0 when clean; exit 1 with the violation lines already on stdout when
not — a deliberate exception to § 0's "nothing on stdout on a refusal": the
violation lines are the entire point of `check`, the pre-push gate every
agent runs before pushing, and a silent exit 1 here would be useless.

### 5.5 `resign-commits <repo> (<lower>..<upper> | <rev> --from-root) [--map-out=<file>] [--policy=<file>] [--apply]`

Re-signs every commit in `<lower>..<upper>` (two dots; `<lower>` exclusive,
`<upper>` inclusive — call this set R0) AND every TRUE descendant of a
member of R0, reachable from any local branch or tag, not just `<upper>`'s
own branch — since a descendant's parent hash changes too and so needs a
new commit object regardless of whether it is itself "in range". `<upper>`
must actually be a descendant of `<lower>`; neither resolving, or `<upper>`
not descending from `<lower>`, is a refusal naming the range (D11, same
`invalid revision range '<r>'` shape as § 5.4's positional range, never an
uncaught crash). The range's SHAPE is a CLI question, checked before the
repo or the policy is even looked at, and each mistake is a usage error
(exit 2, D17): `...` (three dots) — `<range> must be '<lower>..<upper>'
(two dots, not three)`; an empty side (`main..`, `..main`) — `<range> must
be '<lower>..<upper>'`; a bare `<rev>` without `--from-root` — below;
`--from-root` together with a `..` range — `--from-root takes a bare
<rev>, not a range ('<r>')`.
Merge commits anywhere in the rewritten set are refused, same rule as
git-release-squash.

**Root-inclusive form (D15; D17 requires `--from-root`):** `<rev>
--from-root` — a bare revision with no `..` at all — means R0 = every
ancestor of `<rev>`, root commit included — the same thing a single
revision already means to `git rev-list` itself. Without `--from-root`, a
bare `<rev>` is a usage error, nothing touched: `'<rev>' has no '..' --
that re-signs the whole history down to the root; pass --from-root if you
mean that, or use <lower>..<upper>`. The dry run of the root-inclusive
form prints `resign-commits: root-inclusive: <N> commits` (N = the whole
rewrite set, descendants included) as its FIRST line. There is no
earlier commit to name as `<lower>` for a history's very first commit, so
this is the only way to say "re-sign everything". The candidate superset's
walk and the `<upper>`-descends-from-`<lower>` sanity check both simply
skip the lower side when there isn't one; everything else (the rewrite,
atomicity, tag-on-tag, verification) is identical either way.

> **Warning:** a bare revision means neither "that one commit" nor "the
> last N commits" — which is why it needs `--from-root`.
> `resign-commits <repo> main --from-root` — and just as much
> `resign-commits <repo> HEAD~3 --from-root` — re-signs EVERY ancestor of it down to
> the root, plus every descendant of those on any local branch or tag:
> usually the entire history. Every one of those commit hashes changes,
> and every affected branch and tag then needs a force push. To re-sign
> only the last N commits, write `HEAD~N..HEAD`. Always run without
> `--apply` first and read the list of commits, branches and tags it
> would touch.

**Precise selection rule (D14, CRITICAL fix, reviewer-found):** the
rewrite set is R0 UNION every commit transitively descended from a member
of R0 — never merely "every commit that is not an ancestor of `<lower>`".
The two are not the same set: a branch forked AT (or before) `<lower>`
that never merges back, or a branch with entirely unrelated history (an
orphan branch, say), is "not an ancestor of `<lower>`" without having any
real relation to `<range>` at all, and an earlier version of this rule
(`rev-list --branches --tags ^<lower>` alone) silently caught and moved
both. The fix walks the candidate superset (still `rev-list --topo-order
--reverse --branches --tags ^<lower>`, needed to catch real descendants on
branches other than `<upper>`'s own) in topological order, and marks a
candidate for rewrite only if it is literally in R0 (`rev-list
<lower>..<upper>`) or at least one of its real parents has already been
marked — true transitive descendance from R0, computed in one pass since
topological order guarantees every parent is visited before its children.
A ref (branch, or tag — see below) is "affected" (and so moves at all)
only if its tip ends up marked by this rule; everything else is left
byte-for-byte untouched, proven by AC-54's fixture (a side branch forked
at `<lower>` itself, an orphan branch with unrelated history, and a signed
tag on each — none of the three move; a side branch forked at `<lower>`'s
own child in R0 does move, since its tip is a true descendant).

Tree, every mapped parent, author (name/email/date) and committer
(name/email/date), message, and every other header are byte-identical to
the original — ONLY the signature changes, verified afterwards (below).
Author/committer dates are kept EXACTLY as recorded (the original offset,
never recomputed from `policy.timezone`). **Precondition, checked before
anything is written, dry run or not**: every commit to be re-signed must
already carry `policy.identity` as BOTH author and committer — otherwise a
refusal naming the commit; identities are never changed by this command.

Signature time (`signTimeFor`, `lib/policy.ts`, shared by `commit`/`tag`/
`resign-tags`/`resign-commits`): the commit's own committer date — UNLESS
that predates `policy.signingKey`'s own creation time, in which case it is
clamped up to the first policy-ALLOWED minute at or after `created + 60s`
(D1's universal rule, generalized: a signature can never predate its own
key, whether the key was rotated after the commit was first signed, or the
commit's date is simply older than the key — found missing here while
dogfooding against nanojira's real history, D11; the floor is NOT the raw
`created + 60s` instant itself, since that can fall inside a forbidden
window too — found dogfooding the fix itself, D13). A committer date
exempted by `anonymousBefore` uses the D10 pin (`created + 60s` EXACTLY,
unaffected by D13) instead, exactly as § 5.4 checks it.

Refs: every local branch whose tip is a rewritten commit moves to its new
hash. Every annotated tag on a rewritten commit is re-created on the new
hash, same tagger line and message bytes, signature time per the same
rule (tagger date, clamped if needed, or the D10 pin); every lightweight
tag on a rewritten commit moves its ref directly. Remote-tracking refs are
never touched, never read for this computation (`--branches --tags`, not
`--all`).

**Atomicity (D14, HIGH fix, reviewer-found; tag construction hardened
further per D14's own two-attempts writeup):** every new object — every
rewritten commit, and every re-created signed tag object — is created
before any real branch or tag ref is moved for real. A signed tag's new
object is built by `buildSignedTagObject`: the tag's raw text
(`object`/`type`/`tag`/`tagger`/blank line/message) is written by hand,
signed DETACHED with the same `--faked-system-time` gpg wrapper
`createSigner` builds for everything else, and the signed result is
written straight to the object store via `git hash-object -t tag -w
--stdin` — which, like `commit-tree` for a commit, never creates or moves
ANY ref. (Two earlier approaches — a throwaway temporary tag name, and
creating under the real name then reverting the incidental ref move —
both corrupt the object or leave a genuine, if narrow, crash window; see
D14 for why.) Only once every object this command will need already
exists does it move every branch and tag together, in ONE `git update-ref
--stdin` transaction (`start`/`update <ref> <new> <old>`, one line per
ref, each `<old>` checked/`prepare`/`commit`) — all-or-nothing. A failure
building any object (a signing failure on some tag, say) means the
transaction is never even reached: nothing moves, not even a ref
processed earlier in the same run, and the backup bundle taken before any
of this started is still there to restore from (§ 4.1, restore recipe
below). `resign-tags` (§ 5.3) follows the identical pattern when it moves
more than one tag.

**Unverifiable old signature, named on replacement (D15):** neither this
command nor `resign-tags` ever refused or crashed on an existing signature
they cannot verify (no public key for it in this keyring) — both already
unconditionally overwrite any existing signature regardless of its own
validity. What they now additionally do is name it: before resigning,
each commit/tag's OLD signature status is checked, and if it is
`unknown-key` (NO_PUBKEY), an extra line is printed — `<sha> would replace
unverifiable signature (key <keyid>)` in dry run, `<sha> replaced
unverifiable signature (key <keyid>)` once applied — naming the key that
can no longer be checked at all. Not printed for a signature that IS
cryptographically good but by some other key (`wrong-key` — already a
distinct, correctly-reported case, not "unverifiable"), nor for one gpg
itself calls outright invalid with no key id to show (`bad`).

**Tag-on-tag (D14, MEDIUM fix, reviewer-found):** an affected signed tag
whose own IMMEDIATE target (not the fully-dereferenced commit used to
decide affectedness in the first place) is ANOTHER tag, not a commit
directly, is never flattened onto the commit. It is re-created once its
inner tag's own new object exists, pointing AT that new inner tag object,
with the same `type tag` header the original carried — preserving the
chain exactly, however deep. Dependency order between a chain's tags is
resolved by an iterative work queue (no fixed processing order is
assumed), refusing cleanly, naming every remaining tag, if some
dependency can never resolve (should not happen for any acyclic tag
chain, which is the only kind git itself can construct).

Dry run (default): prints which commits would be re-signed, which
branches/tags would move, and writes no objects (D2) — but, unlike
`plan`/`tail`, does NOT show the new shas: there is no no-write form of
`commit-tree -S` (§ 5.1's own rule, same reason), so a dry run honestly
cannot know a re-signed commit's hash before actually invoking gpg and
writing the object. The root-inclusive form's dry run (and only it) starts
with the `root-inclusive: <N> commits` line above.

`--apply`: creates the backup bundle first (§ 4.1); re-signs oldest-first
so every parent mapping is available by the time its child needs it;
moves refs; writes `--map-out`'s `<old-sha> <new-sha>` lines (one per
rewritten commit AND per moved tag) to a file outside the repo (§ 4.4's
rule, reused) if given. Afterwards: `verify: tree delta` (every new tree
equals its original); `verify: resign-commits: headers preserved` (every
`cat-file commit` with `parent`/`gpgsig` lines stripped is byte-identical
between old and new); `verify: resign-commits: parents mapped` (every new
commit's own parent line equals the expected mapped — or, for the first
rewritten commit on a chain, unchanged — parent); `verify: resign-commits:
check (signature/sig-time)` (re-running `check`'s own logic against the
new shas finds 0 `signature`/`sig-time` violations — identity/date/message
are untouched by a re-sign and so are not re-checked here). Exit 0 only if
every verification passes; never pushes, printing the exact commands
instead: `# git push --force-with-lease=<branch>:<old-sha> <remote> <branch>`
per moved branch, `# git push --force-with-lease=refs/tags/<tag>:<old-sha>
<remote> refs/tags/<tag>` per moved/re-signed tag — `<remote>` a literal
placeholder, as in § 5.3. Each rewritten commit's line is
`resign-commits: <old-short> -> <new-short>`, with ` (unchanged)` appended
when a deterministic signature at the same signature time reproduced the
identical object; a branch or tag whose sha did not change gets no push
line (D17).

**(decision, D13)** A real (non-anonymous) commit whose own date predates
the signing key is clamped to the first policy-ALLOWED minute at or after
`created + 60s`, not the raw pin itself — that floor is a constant for a
given key+policy pair (like the D10 anonymous pin, it leaks nothing), and
because it is by construction never inside a forbidden window, `check`'s
ordinary `sig-time` rule (§ 5.4) needs no special case for it: a
`resign-commits`/`commit`/`tag`/`resign-tags` signature produced this way
always passes `check` cleanly on its own terms. (An earlier draft of this
rule clamped to the raw `created + 60s` pin unconditionally, which could
itself fall inside a forbidden window and so trade one `check` violation
for another — found dogfooding; superseded by this rule before release.)

## 6. Acceptance criteria

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
| AC-41 | ac-41-npm-install-bin-resolves.ts | D7: a `node_modules`-shaped fixture resolves and runs a tool end to end |
| AC-42 | ac-42-sign-commit-basic.ts | `commit`: dry run report, `--apply` identity/date/key/signature from the policy (not repo config), forbidden message and forbidden window both refused |
| AC-43 | ac-43-sign-commit-amend.ts | `commit --amend`: author date/identity pinned to the chosen values despite git's own amend quirk; lower bound is the grandparent's committer date |
| AC-44 | ac-44-sign-commit-date-auto.ts | `--date=auto`: latest allowed minute <= now; walks back out of a forbidden window; refuses naming the next allowed minute when none exists |
| AC-45 | ac-45-sign-tag.ts | `tag`: dry run/apply shape, refuses an existing tag name, refuses a date not after the target's committer date |
| AC-46 | ac-46-sign-resign-tags.ts | `resign-tags`: default selection (not signed by the policy key), skips lightweight, explicit list overrides selection, target/tagger/message bytes unchanged, backup bundle, verify lines, push hint, idempotent re-run |
| AC-47 | ac-47-sign-check.ts | `check`: clean range exit 0, named violation lines (identity/signature/date/message) and exit 1, no-upstream refusal, `--tags` |
| AC-48 | ac-48-sign-policy-validation.ts | policy file: missing/malformed/inside-repo/unknown-key/bad-timezone/bad-key/bad-window/bad-regex/bad-`anonymousBefore` are each a refusal naming the problem; a valid `anonymousBefore` is accepted |
| AC-49 | ac-49-sign-check-hardening.ts | `check`: a leaked real-time signature on an allowed-date commit is caught as `sig-time` (and fails closed when unreadable); positional `<range>` is honoured and conflicts/extra positionals are usage errors; `anonymousBefore` exempts the date rule only, never identity; `forbiddenMessagePatterns` match case-insensitively; `signature` detail distinguishes missing/unknown-key/wrong-key; an anonymised object's `sig-time` is checked against the D1 pin exactly (clean when it matches, a named violation when it doesn't), while a real-dated object keeps the window rule |
| AC-50 | ac-50-sign-check-invalid-range.ts | `check`: an unresolvable range (e.g. `<root>~1..HEAD`) or syntactic garbage is a refusal naming the range, exit 1, nothing on stdout, no stack trace -- never an uncaught crash |
| AC-51 | ac-51-sign-resign-commits.ts | `resign-commits`: dry run lists every commit/branch/tag affected across branches forked mid-range and writes no objects; `--apply --map-out=` rewrites the full descendant set with mapped parents, byte-identical headers/message, re-created annotated tag and moved lightweight tag, a clean follow-up `check --tags`, correct push hints, and a backup bundle; refuses a commit not authored/committed by the policy identity, naming it; refuses a merge commit in range, naming it; an anonymised commit's new signature time is pinned exactly to `created + 60s` (D10); a real commit older than the signing key is clamped to the first policy-allowed minute at/after `created + 60s` -- never the raw pin, which can itself fall inside a forbidden window -- rather than crashing gpg with a time-warp error, while its own committer date on the object stays untouched (D11/D13) |
| AC-52 | ac-52-sign-commit-date-before-key.ts | `commit --date=<date before the signing key>`: against a policy whose forbidden window deliberately covers the raw `created + 60s` pin, the signature is clamped to the first allowed minute at/after it, not the pin itself; no crash, no forbidden-window refusal; a follow-up `check` reports 0 violations with no special case needed (D13) |
| AC-53 | ac-53-sign-allowed-minute-cap-defensive.ts | `nextAllowedMinuteAfter`/`signTimeFor` (white-box unit test, not black-box): once the 20160-step search cap is exhausted, returns `null`/refuses instead of silently returning a still-forbidden instant -- exercised via a hand-built, schema-circumventing `Policy` (`to: '24:00'`) no file loader could ever produce, since any schema-valid policy always leaves some minute open (D14) |
| AC-54 | ac-54-sign-resign-commits-range-selection.ts | `resign-commits`: the precise selection rule (D14, CRITICAL) -- a side branch forked AT `<lower>` and an orphan branch with unrelated history are left byte-for-byte untouched (dry run never lists them, `--apply` moves nothing of theirs), while a side branch forked at a true R0 member IS rewritten/moved, same for a signed tag on each |
| AC-55 | ac-55-sign-resign-commits-atomic.ts | `resign-commits`: atomicity (D14, HIGH) -- a forced object-creation failure on the second of two tags (a pre-existing `refs/tags/<name>.lock` file, the same lock git's own ref-update machinery uses) leaves every ref, including one processed earlier in the same run, exactly as it was, with the backup bundle still present; removing the injected failure and retrying the identical command then succeeds cleanly |
| AC-56 | ac-56-sign-resign-commits-tag-on-tag.ts | `resign-commits`: tag-on-tag (D14, MEDIUM) -- an outer signed tag whose immediate target is another (inner) signed tag is re-created pointing at the new inner tag object, `type tag` preserved, never flattened onto the commit; both tags' own `tag <name>` header is correct (not some temporary name) and both verify |
| AC-57 | ac-57-sign-resign-double-signature.ts | `resign-tags`/`resign-commits`: resigning an ALREADY-SIGNED tag never corrupts it with two concatenated signature blocks (item 0, CRITICAL, Lead-directed) -- the message is read from the raw object, never `for-each-ref --format=%(contents)`; the new object has exactly 1 signature block, the message itself is exactly the original text with nothing embedded, `git tag -v` and `check --tags` both stay clean; mutation-tested by reverting to `%(contents)` and confirming the exact `verify: ...: FAILED (multiple-signatures)` symptom |
| AC-58 | ac-58-sign-check-multiple-signatures.ts | `check`: an object (tag or commit) hand-constructed with 2 concatenated signature blocks/`gpgsig` headers -- independent of any one tool producing it -- is reported as `multiple-signatures (<N> signature blocks found)`, never `missing`/`bad`/anything else, never silently passed clean, never a crash |
| AC-59 | ac-59-sign-resign-commits-root-range-unverifiable.ts | `resign-commits`/`resign-tags` (D15, Lead-directed): a bare `<range>` with no `..` re-signs every ancestor root-inclusive -- a 3-commit history's root keeps its (parentless) new commit, same tree, `git verify-commit` clean on every new commit; a commit/tag signed by a key not in this keyring (NO_PUBKEY) is reported as `... would replace unverifiable signature (key <keyid>)` in dry run and `... replaced unverifiable signature (key <keyid>)` on apply, never printed for an already-correctly-signed object; mutation-tested by reverting the bare-range acceptance (reproduces the old `<lower>..<upper>` refusal) and by reverting `unverifiableKeyLabel` to always return null (reproduces the silent, unnamed replacement) |
| AC-60 | ac-60-policy-boundaries.ts | policy windows through the CLI (`commit --date=…` dry runs): `from` inclusive, `to` exclusive (07:00 forbidden, 19:00 allowed), weekday-only windows (Saturday never forbidden under a mon–fri policy), Europe/Berlin DST transitions; a non-existent (spring-forward) or ambiguous (fall-back) wall time is a refusal naming it, an explicit offset sidesteps both; the process's own timezone never changes the result |
| AC-61 | ac-61-sign-signature-boundary-quoted-blocks.ts | `check`/`resign-tags`/`resign-commits` (D16, Lead-directed pre-review): a tag whose message quotes an old PGP signature block followed by further real text is read, re-created, and reported as 1 signature block, message byte-exact including everything after the quote (via both `resign-tags` and `resign-commits`'s tag path); a quote with nothing between it and the real trailing signature is -- correctly, deliberately -- still `multiple-signatures`, indistinguishable from item-0's own corruption; a validly-signed commit whose MESSAGE contains a line starting with "gpgsig " as prose is never miscounted as a second signature; mutation-tested against both the tag-side (last-marker → first-marker, stacked-count → raw-occurrence-count) and commit-side (header-region-only → whole-object) reverts |
| AC-62 | ac-62-sign-resign-commits-from-root.ts | `resign-commits` (D17): a bare `<rev>` (`main`, `HEAD~1`, with or without `--apply`) is a usage error naming `--from-root`, no ref moved, no object written; `<rev> --from-root`'s dry run starts with `root-inclusive: <N> commits` (a `..` range never prints it); `...`, an empty side, and `--from-root` with a range are usage errors with ONE `git-sign:` prefix, checked before the policy; an unresolvable revision stays a refusal; push hints use the literal `<remote>`, and a byte-identical re-run reports `(unchanged)` with no push hint; mutation-tested (the `--from-root` check, the count line, `<remote>`, the unchanged-branch skip) |
| AC-63 | ac-63-sign-gpg-program-policy.ts | `gpgProgram` (D17): a repo `gpg.program` that would fail every call is never run by `check`, `commit --apply` or `resign-commits --apply` (git's own `verify-commit` included); the policy's `gpgProgram` is used for signing and verification; a relative path, a non-string, a missing file, a directory and a non-executable file are each a policy refusal naming the problem; mutation-tested (no `GIT_CONFIG_*` override; policy key ignored) |
| AC-64 | ac-64-sign-help-usage-messages.ts | `git-sign --help`/`-h`/`help`: every synopsis on stdout, exit 0; `<sub> --help`: exactly that synopsis; no subcommand: exit 2, `missing subcommand` + synopses on stderr; `--message --apply` (and `git-leak-scan --terms --allow`) is `missing value for --<flag>`, nothing written, while `--message=--apply` is accepted (D17); `tag` names "the target's" committer date, `commit` "the parent's"; `resign-tags` on a byte-identical re-sign reports `(unchanged)` with no push hint; mutation-tested (missing-value rule, label, unchanged-tag skip) |
| AC-65 | ac-65-sign-unsigned-tag-quoted-blocks.ts | `resign-tags`/`resign-commits` (D18, HIGH, Lead-found via the Reviewer's pre-review of D16): an UNSIGNED tag whose message quotes a complete block in the MIDDLE with real text after it keeps its full message byte-exact through both tag-resigning paths (D16's own fix still truncated it, since `lastTagSignatureBeginIndex` and `stackedTagBlockCount` could disagree on this one shape); `cmdResignTags`'s verify step independently re-derives the old message via a different, regex-based method and would now fail rather than falsely report `OK` if the shared boundary walk alone were wrong; an unsigned tag whose message ENDS with a complete quoted block is refused (exit 1, naming the tag) by both paths rather than guessed at; mutation-tested against the unified boundary function (reverting `index` to the old bare `lastIndexOf`), the independent verify check (disabling it on top of the boundary mutation reproduces the false `OK`), and each refusal condition independently |
