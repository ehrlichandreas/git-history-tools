---
name: git-history-tools
description: "Four tools for preparing a git history for publication: git-release-squash folds commits into one per tag, git-leak-scan searches every reachable blob/message/identity for emails/URLs/paths/hostnames/IPs/secrets/custom terms, git-history-rewrite applies literal text replacements or adds a file into every commit, git-sign is a policy-enforcing commit/tag, re-signs existing tags or commit ranges (resign-tags/resign-commits), plus a read-only check gate for identity, signature, forbidden time windows and forbidden message patterns. All four keep commits signed and never push. Use when a repository's history needs to be squashed to tagged releases, checked for leaked information before going public, rewritten to remove sensitive strings, or committed/tagged/audited under an explicit identity-and-signing-key policy."
license: MIT
metadata:
  version: "0.4.0"
---

# git-history-tools

Four tools for preparing a git history for publication. All four keep commits
signed, and none of them pushes.

## Usage

`sh <skill>/bin/git-release-squash <subcommand> [args...]`, `sh <skill>/bin/git-leak-scan
<subcommand> [args...]`, `sh <skill>/bin/git-history-rewrite <subcommand> [args...]`,
`sh <skill>/bin/git-sign <subcommand> [args...]` (relative to this skill's own
folder). Needs only Node.js >= 24, no other dependency.

Every writing subcommand is a dry run unless `--apply` is given: it prints the
same report it would with `--apply`, changes no ref, creates no bundle.

### git-release-squash (`bin/git-release-squash`)

- `plan <repo> [--name=<name>]` -- read-only. Prints, per tag reachable from
  HEAD, how many commits fold into it and a tree-equality check.
- `apply <repo> --map <file> [--name=<name>] [--dates=anon|keep] [--apply]`
  -- squashes the whole tagged history to one commit per tag. Refuses unless
  HEAD is itself tagged (run `tail` first otherwise). Writes `<file>` with one
  `<old-sha> <tag>` line per original commit.
- `tail <repo> [--name=<name>] [--dates=anon|keep] [--tag=<tag> (--message=<text>|--message-file=<path>)] [--apply]`
  -- squashes only the untagged commits since the last tag (or the whole
  history, if there are no tags yet) into one commit. Without `--tag`, the
  commit stays untagged, for staging. With `--tag=<tag>`, finishes a full,
  anonymous release in one call: creates an annotated, signed tag `<tag>`
  whose tagger date (under `--dates=anon`, the default) is the same instant
  as the new commit's own date -- a manual `git tag -s` afterwards would
  carry the real tagger date and defeat the anonymisation. Refuses if `<tag>`
  already exists.

### git-leak-scan (`bin/git-leak-scan`)

- `scan <repo> [--terms <file>] [--allow <file>]` -- searches every reachable
  blob, commit/tag message, and author/committer/tagger identity line for
  emails, URLs, local home paths, hostnames, IPs, secrets/private keys, and
  (with `--terms`) the user's own case-insensitive terms. `--allow` suppresses
  known-good exact matches. Exit 0 clean, 1 on hits, 2 on a usage error.

### git-history-rewrite (`bin/git-history-rewrite`)

- `replace <repo> --rules <file> [--hook <script>] [--apply]` -- applies
  ordered `from<TAB>to` literal replacements to every text blob in every
  commit. Refuses if a commit or tag message would change -- it only rewrites
  file contents. `--hook <script>` runs once per distinct resulting root tree
  for project-specific derived files.
- `add-file <repo> <path> [--as <repo-path>] [--apply]` -- puts a fixed
  snapshot of `<path>` into every commit's tree.

### git-sign (`bin/git-sign`)

Unlike the other three, never reads or writes `<repo>`'s own git config for
identity/signing key, and never takes `gpg.program` from any git config --
all three come from a **policy file** (the gpg binary from its optional
`gpgProgram`, an absolute path; default `gpg` from `PATH`)
(`--policy=<file>`, else `$XDG_CONFIG_HOME/git-history-tools/policy.json`,
else `$HOME/.config/git-history-tools/policy.json`; see
`docs/policy.example.json`), which must live outside the target repo (same
rule as `--rules`/`--terms`/`--allow`). `git-sign --help` prints every
subcommand's synopsis, `git-sign <sub> --help` just that one.

- `commit <repo> (--message=<text>|--message-file=<path>) --date=(auto|<date>)
  [--amend] [--policy=<file>] [--apply]` -- commits the staged index with the
  policy's identity, signed by the policy's key. Refuses a message matching a
  forbidden pattern, or a date in a forbidden window or not after the
  parent's own date. `--date=auto` picks the latest allowed minute at or
  before now. `--message-file=-` reads stdin.
- `tag <repo> <tag> (--message=<text>|--message-file=<path>)
  --date=(auto|<date>) [--policy=<file>] [--apply]` -- same rules, tagging
  HEAD; the date must be after HEAD's own committer date. Refuses if `<tag>`
  already exists (use `resign-tags` to re-sign one). `--date=auto` right
  after a `commit --date=auto` in the same minute is refused (no allowed
  minute yet) -- wait for the next minute or pass an explicit `--date`.
- `resign-tags <repo> [<tag> ...] [--policy=<file>] [--apply]` -- re-signs
  annotated tags not already validly signed by the policy key (or an
  explicit list); target, tagger line and message stay byte-identical, only
  the signature changes. Prints the exact `git push --force-with-lease=...
  <remote> ...` command (none for a tag reported `(unchanged)`); never
  pushes.
- `resign-commits <repo> (<lower>..<upper> | <rev> --from-root)
  [--map-out=<file>] [--policy=<file>] [--apply]` -- re-signs every commit in
  `<lower>..<upper>` plus every descendant of one of them on any local
  branch or tag (their parent hashes change too). Tree, mapped parents,
  author/committer (name, email, date) and message stay byte-identical;
  annotated tags on rewritten commits are re-created, lightweight ones
  moved, all refs in one transaction. Refuses merge commits and any commit
  not authored and committed by the policy identity (it never changes
  identities). `--map-out` (outside the repo) gets `<old-sha> <new-sha>`
  lines. Prints `git push --force-with-lease=... <remote> ...` commands
  for every ref that moved; never pushes.
  **Warning:** a bare `<rev>` (no `..`) is root-inclusive, so it is refused
  unless `--from-root` is given: it means neither "that one commit" nor
  "the last N commits" -- `resign-commits <repo> main --from-root` or
  `... HEAD~3 --from-root` re-signs EVERY ancestor down to the root plus
  their descendants, usually the entire history (the dry run's first line
  says how many: `root-inclusive: <N> commits`), and every rewritten
  branch/tag then needs a force push. For the last N commits use
  `HEAD~N..HEAD`. Always run without `--apply` first and read the list.
- `check <repo> [<range>|--range=<range>] [--tags] [--policy=<file>]` --
  read-only. Flags identity, signature, forbidden-window dates (including
  the *signature's own* creation time, not just the commit's), and
  forbidden message patterns (e.g. AI attribution lines) for every commit
  in `<range>` (default `@{upstream}..HEAD`) and, with `--tags`, every
  annotated tag. Exit 0 clean, 1 with the violations printed -- the
  pre-push gate to run before every push.

## Release workflow

To prepare and cut a release:

1. `git-leak-scan scan <repo> [--allow <file>]` -- check the history is clean
   before doing anything else. Fix any real hit with `git-history-rewrite replace`/
   `add-file --apply`, or add a known-good match to the allowlist.
2. `git-release-squash tail <repo> --tag=<tag> --message=<text> --apply` -- finish
   the release: one new anonymous, signed commit and tag in one step (or
   `git-release-squash apply` instead, if every commit up to HEAD is already tagged
   and only needs folding down).
3. Re-run `git-leak-scan scan` on the result, and check the tool's own `verify:`
   lines (tree delta, signatures, and for a squash, every commit tagged) --
   git-release-squash, git-history-rewrite and git-sign's `resign-*` print
   these after every `--apply`.
4. `git-sign check <repo> [<range>] --tags` -- the pre-push gate: must exit 0.
5. Push manually. None of these tools pushes anything, ever.

## Rules and terms files

`--rules`, `--terms` and `--allow` files must live outside the target repo --
pointing one inside the repo is a refusal, not a warning: a file like that
would otherwise get committed the next time the repo's own history is
rewritten.

## Not in scope (v0.4)

Merge histories, rewriting commit messages, pushing, and project-specific
corpus splicing (use `--hook` for that).
