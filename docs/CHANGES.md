# Changes

User-facing changes per release. The contract is `docs/SPECIFICATION.md`;
renames and breaking changes are in `docs/MIGRATION.md`.

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
