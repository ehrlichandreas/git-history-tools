# Changes

User-facing changes per release. The contract is `docs/SPECIFICATION.md`;
renames and breaking changes are in `docs/MIGRATION.md`.

## 0.4.6

- Fix: `resign-commits --apply`, `apply --apply`, `tail --apply`,
  `replace --apply` and `add-file --apply` moved every ref before
  computing their verify lines; a FAILED one left the refs already
  moved, exit 1, the backup bundle the only way back. Every check that
  only reads the new objects by sha (`tree delta`, and for
  `resign-commits` also `headers preserved`/`parents mapped`/`check
  (signature/sig-time)`) is now checked before the ref transaction: a
  FAILED one is a refusal with no ref moved, same as a refusal before
  the bundle. Stdout on success is unchanged (D24).
- Fix: `signatures` and, for `apply`, `every commit tagged` also moved
  before the ref transaction, checked against the planned final ref
  map instead of the live one: `apply --apply` and `tail --apply` could
  still move their own branch and tags before a FAILED `signatures` on
  a second, unrelated branch's own unsigned commit (the check has
  always covered the whole repo, not just the ref being moved) — fixed.
  `replace`/`add-file` re-sign every reachable commit, including an
  "unrelated" one, so this could not actually be forced there in
  practice; their own checks moved too, for the same reason, but change
  nothing observable. Stdout on success is unchanged (D24).
- Fix: an untouched ref -- one neither this run's own moves nor its
  planned final ref map's own checks touch -- could still drift between
  the one read that map came from and the ref transaction landing,
  unnoticed. `apply --apply`, `tail --apply`, `resign-commits --apply`
  and, for one hypothetical edge case, `replace --apply`/`add-file
  --apply` now carry a `verify <ref> <sha>` line in the SAME transaction
  for every such ref: a drifted one aborts the whole transaction, named
  on stderr, same as any other transaction failure -- nothing moves, not
  even this run's own planned refs (Q2 hardening).

## 0.4.5

- Fix: `git-release-squash tail` dates its new commit by its position
  in the history, as § 4.3 says. With an untagged commit before the
  last tag it used to get a date one day per such commit too early,
  as early as its parent's slot.
- New: `--help` (also `-h`, `help`) on every tool, and `<subcommand>
  --help`, as git-sign already had.
- Fix: an extra positional argument is a usage error in
  git-release-squash, git-history-rewrite and git-leak-scan, as in
  git-sign. It used to be ignored.
- Fix: a `--message-file`, `--rules`, `--terms`, `--allow` or add-file
  `<path>` that is missing, a directory or unreadable is a one-line
  usage error (exit 2) instead of a stack trace.
- Change: every `--apply` that writes a backup bundle prints `backup:
  <path>` as its first stdout line, also when a refusal follows. A
  script that expected no stdout from such a refusal sees this line.
- Fix: `git-release-squash plan` prints what § 1.1 says: the subject
  `apply` writes (`<name> <tag>: <title>`), the preview sha of the new
  squash commit instead of the tag object's, and a tree check that is
  computed. A tag message whose first two lines are not separated by a
  blank line no longer has them joined into one title, and `apply`, which
  also stored the tag message with those two lines joined, now keeps the
  message as it was. A title has no CR (from a CRLF message) or other
  control character, in `plan`, `apply` and `tail`. A CRLF tag message
  that `apply` re-creates loses its CRs, as `git tag`'s default cleanup
  always made it.
- Fix: a `--message-file` (`tail --tag`, git-sign `commit`/`tag`) that is
  not valid UTF-8 is a one-line usage error (exit 2) instead of being
  written with U+FFFD in place of its bytes.
- Fix: in a repository with `i18n.commitEncoding` set to anything but
  UTF-8, the commits `apply`, `tail`, `replace` and git-sign `commit`
  wrote carried that `encoding` header over UTF-8 bytes; `replace` also
  re-encoded each message, and `resign-commits` failed its own verify
  after moving the ref. ght's commits now never have an `encoding`
  header, and messages are read as UTF-8, also by `git-leak-scan scan`
  and `git-sign check`, which missed a UTF-8 term or pattern in a repo
  with `i18n.logOutputEncoding` set.
- Fix: `resign-commits` over a commit with an explicit `encoding UTF-8`
  header moved the ref, then failed its "headers preserved" verify
  (exit 1). It now refuses such a commit before anything is written,
  dry run included (exit 1, one stderr line). `replace` drops the header
  and keeps the message bytes.

## 0.4.4

- Change: `git-leak-scan` finds more secret shapes. These include
  `API_KEY=…` and `GITHUB_TOKEN=…`, `password: …` and JSON
  `"password": "…"`, spaces around `=`, base64 values, PGP private key
  blocks, AWS key ids, GitHub, Slack and JWT tokens, and `Bearer` tokens.
  An existing repository can get new hits, and an old hit can now be
  longer. Add the ones that are fine to your `--allow` file.
- Change: `git-leak-scan`'s `local-path` also finds `/root/…`,
  `c:\users\…` in any case, and `~<name>/…`. A bare `~/…` stays
  quiet.
- Docs: the README says gpg is needed for every writing tool, not only
  for signed histories. The bundle restore recipe (spec § 4.1) is now
  tested.
- Faster: `git-leak-scan` reads and scans each distinct blob once,
  however many commits it appears in, and no longer holds every blob in
  memory. The report is unchanged. On nanojira v4.1.2's history (31
  commits) a scan took 59568 ms instead of 444559 ms, with byte-identical
  output.
- Fix: `git-leak-scan` no longer takes hours on a long line of hex,
  base64 or dotted text; such a line costs time in proportion to its
  length. Many hits in one file are cheap as well: 40000 took 12 s
  before.
- Change: `git-leak-scan` also finds camelCase names (`authToken`,
  `dbPassword`, `awsSecretAccessKey`), `apikey` written flat, and GitHub
  `github_pat_`, Stripe `sk_live_`/`rk_live_`, Google `AIza` and GitLab
  `glpat-` tokens. Existing repositories may get new hits; `--allow`
  absorbs them.
- Fix: a refusal no longer leaves a backup bundle behind. A missing or
  unreadable signing key, `add-file` onto a directory, and `resign-*`'s
  key and tag checks now run before the bundle is created. `apply
  --map` into a missing directory, or onto a directory, is a usage error
  instead of a crash after the bundle.
- Fix (D17): a repository's `gpg.format=ssh` with its own
  `gpg.ssh.program` or `gpg.x509.program` can no longer run code through
  git-sign, not even through the read-only `check`. Every pinned
  `gpg.program` now comes with `gpg.format=openpgp` and empty SSH and
  X.509 programs; this covers the signing calls of all tools.
- Fix: `git-sign check` and `resign-commits` never read a revision
  range as a git option. `check --range=--output=<file>` used to create
  `<file>`. A range (or a side of it) starting with `-` is now a usage
  error.
- Fix: `git-release-squash apply`/`tail` and `git-history-rewrite` build
  every new object first and then move every branch and tag in one
  transaction. Each ref must still hold the value read when the run
  started, and a new tag must not exist yet. A failure partway through
  used to leave some refs moved and others not; `tail --tag` moved the
  branch before it created the tag. A `tail --tag` message that is empty
  is now a usage error. `git-history-rewrite` also refuses if any branch
  or tag was created, moved or deleted while it worked, including while
  it signed the tags; a branch or tag created in the last moment before
  the transaction is named, with exit 1.
- Fix: `git-release-squash tail --tag=<tag>` and `git-sign tag` check
  the tag name first; an invalid one is a usage error. `tail
  --tag='bad name' --apply` used to move the branch, create no tag and
  crash.
- Fix: a branch and a tag may share a name. `git-history-rewrite` and
  `git-release-squash apply` used to create stray `refs/heads/heads/<x>`
  and `refs/tags/tags/<x>` refs and leave the real ones on the old
  history; `tail` and `apply` crashed. All four tools now use full
  refnames.
- Fix: `git-history-rewrite` re-creates every annotated tag with its
  message byte for byte and exactly one signature. A signed tag used to
  get its old signature embedded in the message, and so two signature
  blocks, while verify said OK; `#` lines and trailing spaces in a tag
  message were dropped. The one exception: a message without a trailing
  newline gets one. Without it the signature was unreadable, in
  `git-sign resign-tags` and `resign-commits` too.
- Fix: `<repo>` alone names the repository. A caller's `GIT_DIR`,
  `GIT_WORK_TREE`, `GIT_CONFIG_PARAMETERS` and the other variables git
  reads before `-C` are removed first. `GIT_DIR=B/.git
  git-history-rewrite replace A --apply` used to rewrite B. The caller's
  `user.name`, `user.email` and `user.signingkey` as `GIT_CONFIG_COUNT`
  entries still pass, so a release script can supply the signing
  identity that way; every other key is dropped.
- Fix: a commit or tag that is not UTF-8 (bytes like `\351`, or an
  `encoding` header such as ISO-8859-1) is refused before anything is
  written, exit 2. `git-history-rewrite` used to turn such bytes into
  U+FFFD, re-sign the result and report success; `git-sign resign-tags`
  moved the ref before it reported verify FAILED.
- Fix: replace refs (`git replace`) no longer hide anything. Every tool
  works on the objects a push sends; `git-leak-scan` used to miss a
  secret commit hidden behind a replacement.
- Fix: a NUL byte in `git-release-squash tail --tag`'s message is a
  usage error up front. It used to crash after writing the backup
  bundle.
- Fix (security): a signing key that starts with `-` is refused before
  gpg runs, exit 2. A repository's or caller's `user.signingkey` of
  `--options=<file>` made `git-history-rewrite` and
  `git-release-squash` hand that file to gpg, which could run a program
  named in it. git-sign was not affected.
- Change: no tool runs the repository's own hooks or fsmonitor any
  more. `git-sign commit` used to run `pre-commit`, `commit-msg` and
  `post-commit`, and every writing tool ran a `reference-transaction`
  hook. If you rely on such a hook (Git LFS, for example), run it
  yourself afterwards.
- Fix: `git-release-squash tail`/`apply --apply` work on a bare
  repository. They used to crash in the dirty check.
- Change: the backup bundle is named after the real top level and goes
  next to it, also when `<repo>` is a symlink. A link `r/self -> .`
  used to put the bundle inside the work tree.
- Fix: `git-release-squash apply --map` writes the map only after every
  ref has moved; a failed run leaves no map file.
- Fix: a tool run with no subcommand says so and lists its
  subcommands, instead of "unknown subcommand 'undefined'".
- Fix: a tag whose name starts with `-` no longer crashes
  `git-release-squash apply`, and no longer fails `git-sign
  resign-tags`' verify.
- Fix: a subdirectory of a work tree given as `<repo>` is now refused,
  naming the top level, by every tool. `git-history-rewrite replace
  <repo>/sub --apply` used to rewrite the whole history down to that
  subdirectory (every file outside it gone), report OK, and leave its
  backup bundle inside the work tree.
- Test suite: a tool that hangs or floods its output is a FAIL, no
  longer counted as "cannot run", and any "cannot run" now makes
  `npm test` exit 1 (AC-69).

## 0.4.3

No change to the four tools: `git-release-squash`, `git-leak-scan`,
`git-history-rewrite` and `git-sign` behave exactly as in 0.4.2. This
release changes only the test suite, which runs from a clone
(`npm test` / `node test/run-all.ts`):

- A test file still running at the per-file timeout (120 s) is now a
  FAIL, whatever it exits with later, and its report says it timed out.
  The pool sends SIGTERM, then SIGKILL after 10 s; a file run serially
  (`--jobs=1`, or marked `@serial`) gets SIGKILL at once. A file that
  ignores SIGTERM can no longer keep the run waiting; AC-68 checks this.
- A test that dies before it finishes (an uncaught exception, an
  unhandled rejection, a bare `process.exit()`) still removes its fixture
  directories. The harness installs no signal handler, so it never holds
  off run-all's kill; AC-67 checks this.
- `@slow` marks follow a fixed rule (`docs/DECISIONS.md` D19): a file's
  time over the pool mean, the median of three pooled runs, is marked at
  4.0 or more and unmarked below 3.0. ac-40, ac-53 and ac-60 are marked,
  so they start first; in the measured runs the median pooled wall went
  from 45.3 s to 41.1 s.

## 0.4.2

No change to the four tools: `git-release-squash`, `git-leak-scan`,
`git-history-rewrite` and `git-sign` behave exactly as in 0.4.1. This
release changes only the test suite, which runs from a clone
(`npm test` / `node test/run-all.ts`):

- The suite runs its files in a pool: `--jobs=<n>` or `GHT_TEST_JOBS`,
  default min(cores, 8); `--jobs=1` is the old serial run. Each file's
  output is printed in file order, so a pooled run reads like a serial
  one. Files marked `@serial` run alone after the pool, and `@slow` files
  start first.
- All node processes of a run share one compile cache, removed at the
  end, so `lib/` and the harness are not compiled again for every tool
  call.
- `GHT_TEST_TIMES=<file>` writes each test file's wall time as TSV.
- Every test is isolated from the machine's git config and git-sign
  policy (`GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_NOSYSTEM=1`, an
  empty `XDG_CONFIG_HOME`). A key no fixture sets itself, such as a
  global `gpg.format=ssh` or `core.hooksPath`, or the owner's own
  git-sign policy, can no longer change a result; AC-66 checks this.

## 0.4.1

- Fix: no temporary directory is left behind when writing a temporary
  file fails right after the directory was made (a full disk, a failed
  `chmod`): the gpg signing wrapper of `git-release-squash`,
  `git-history-rewrite` and `git-sign`, and the message file of every
  signed commit and tag. `git-sign commit`/`tag` no longer leak the
  signing wrapper's directory when writing the message file fails. The
  error itself is reported as before.

## 0.4.0

Additive: a fourth tool, `git-sign`. The three existing tools keep their
flags and output, apart from one breaking flag-parser fix (last bullet;
see `docs/MIGRATION.md`).
Includes the two fixes that followed v0.3.1.

- **`git-sign commit` / `git-sign tag`: sign under an explicit policy.**
  Identity, signing key and gpg binary come from a policy file and reach git
  only on the invocations that need them (`GIT_AUTHOR_*`/`GIT_COMMITTER_*`,
  `-c user.signingkey=`, `gpg.program` forced via `-c`/`GIT_CONFIG_*`) —
  never git config: git-sign never runs a `gpg.program` set in any git
  config, not even through the `git verify-*` calls it makes (the other
  three tools still honour `gpg.program` as before). `--date=auto|<date>`.
  Refused before anything is written: a message matching a forbidden pattern
  (e.g. an AI attribution line), a date inside a forbidden window, a date not
  after the parent's (for `tag`: the target's) committer date. Dry run
  unless `--apply`. `tag` targets HEAD and never overwrites an existing
  tag. `git-sign --help` lists every subcommand's synopsis, `git-sign <sub>
  --help` just that one.
- **The policy file.** `--policy=<file>`, else
  `$XDG_CONFIG_HOME/git-history-tools/policy.json`, else
  `~/.config/git-history-tools/policy.json`; must live outside the repo.
  Strict schema — every key required, an unknown key is a refusal: `identity`,
  `signingKey`, `timezone` (IANA, DST-aware), `forbiddenWindows`,
  `forbiddenMessagePatterns` (case-insensitive regexes, compiled at load),
  optional `anonymousBefore` (exempts placeholder dates such as
  git-release-squash's 1970 ones from the window check only), optional
  `gpgProgram` (absolute path to the gpg binary; default `gpg` from
  `PATH`). Example:
  `docs/policy.example.json`.
- **DST-safe dates.** A `--date` wall time that does not exist (spring-forward
  gap) or occurs twice (fall-back hour) in the policy's zone is a refusal,
  never silently shifted.
- **A signature never predates its key.** A date older than the signing key is
  signed at the first policy-allowed minute at or after the key's creation +
  60 s; an anonymous object is signed at exactly that pin.
- **`git-sign resign-tags`** re-signs annotated tags, changing nothing but the
  signature (default: every tag not validly signed by the policy key;
  idempotent). Lightweight tags are skipped and reported. The message is read
  from the raw tag object, so an already-signed tag never ends up with two
  signature blocks. Prints a `git push --force-with-lease=… <remote> …` line
  per moved tag; a tag whose re-signed object is byte-identical (EdDSA at
  the same signing time) is reported `(unchanged)` and gets none.
- **`git-sign resign-commits <lower>..<upper>`, or `<rev> --from-root`**
  re-signs those commits and every true descendant: tree, mapped
  parents, author, committer and message stay byte-identical; only the
  signature changes. All new objects are written before any ref moves; then
  every affected branch and tag moves in one atomic `update-ref`
  transaction. Tag-on-tag chains are preserved. `--map-out=<file>` records
  old → new. Backup bundle first, verification after. Every commit must
  already carry the policy identity. A bare `<rev>` re-signs everything
  down to the root, so it is a usage error without `--from-root`, and that
  form's dry run starts with `root-inclusive: <N> commits`. Push hints use
  the literal `<remote>` and skip refs whose sha did not change.
- **Unverifiable signatures are named.** When `resign-commits`/`resign-tags`
  replace a signature whose key is not in the keyring, they say so:
  `<sha> would replace` / `replaced unverifiable signature (key <keyid>)`.
- **`git-sign check [<range>] [--tags]`** — a read-only pre-push gate:
  - identity;
  - signature: missing, unknown key, wrong key, bad, or **more than one
    signature block** (never resolved by picking the first);
  - dates against the forbidden windows;
  - the signature's own creation time: the windows for real-dated objects,
    the exact pin for anonymous ones;
  - forbidden message patterns.
  One line per violation; exit 1 if there is any.
- **Fix: verification and rewrites walk only local branches and tags.**
  `git-release-squash`'s signature verify and `git-history-rewrite`'s commit
  walk used `--all`, which pulled in remote-tracking refs, stash and notes;
  both now use `--branches --tags`. (D4, D5)
- **Fix: `bin/*` work when installed as an npm dependency.** The wrappers
  follow npm's `node_modules/.bin` symlinks, and the package's `bin` entries
  run the bundled `dist/*.mjs` (Node refuses to strip types under
  `node_modules`). (D6, D7)
- **Fix (breaking, all four tools): a flag is never taken as another
  flag's value.** `--message --apply` used to read the message "--apply"
  and silently drop `--apply`; `git-leak-scan scan <repo> --terms --allow
  <f>` used `--allow` as the terms file. A space-separated value starting
  with `--` is now the usage error `missing value for --<flag>` (exit 2)
  instead of being silently misread. Pass such a value as
  `--flag=--value`. (D17; `docs/MIGRATION.md`)

## 0.3.1

- Fix: a `--terms`/`--allow`/`--rules` symlink outside the repo pointing
  inside it is refused; the backup bundle of a relative `<repo>` (`.`) lands
  beside the repo, not inside it. (D3)

## 0.3.0

- **Breaking:** the commands are `git-release-squash`, `git-leak-scan` and
  `git-history-rewrite`, usable as `git release-squash` etc. See
  `docs/MIGRATION.md`.

## 0.2.0

- **Breaking:** `ght-squash`/`ght-scan`/`ght-rewrite` are renamed to
  `release-squash`/`leak-scan`/`history-rewrite`; the repo is ESM +
  TypeScript and needs Node ≥ 24. See `docs/MIGRATION.md`.

## 0.1

- release-squash, leak-scan and history-rewrite with signed, anonymous
  releases.
