---
name: git-history-tools
description: "Three tools for preparing a git history for publication: release-squash folds commits into one per tag, leak-scan searches every reachable blob/message/identity for emails/URLs/paths/hostnames/IPs/secrets/custom terms, history-rewrite applies literal text replacements or adds a file into every commit. All three keep commits signed and never push. Use when a repository's history needs to be squashed to tagged releases, checked for leaked information before going public, or rewritten to remove sensitive strings."
license: MIT
metadata:
  version: "0.2.0"
---

# git-history-tools

Three tools for preparing a git history for publication. All three keep commits
signed, and none of them pushes.

## Usage

`sh <skill>/bin/release-squash <subcommand> [args...]`, `sh <skill>/bin/leak-scan
<subcommand> [args...]`, `sh <skill>/bin/history-rewrite <subcommand> [args...]`
(relative to this skill's own folder). Needs only Node.js >= 24, no other
dependency.

Every writing subcommand is a dry run unless `--apply` is given: it prints the
same report it would with `--apply`, changes no ref, creates no bundle.

### release-squash (`bin/release-squash`)

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

### leak-scan (`bin/leak-scan`)

- `scan <repo> [--terms <file>] [--allow <file>]` -- searches every reachable
  blob, commit/tag message, and author/committer/tagger identity line for
  emails, URLs, local home paths, hostnames, IPs, secrets/private keys, and
  (with `--terms`) the user's own case-insensitive terms. `--allow` suppresses
  known-good exact matches. Exit 0 clean, 1 on hits, 2 on a usage error.

### history-rewrite (`bin/history-rewrite`)

- `replace <repo> --rules <file> [--hook <script>] [--apply]` -- applies
  ordered `from<TAB>to` literal replacements to every text blob in every
  commit. Refuses if a commit or tag message would change -- it only rewrites
  file contents. `--hook <script>` runs once per distinct resulting root tree
  for project-specific derived files.
- `add-file <repo> <path> [--as <repo-path>] [--apply]` -- puts a fixed
  snapshot of `<path>` into every commit's tree.

## Release workflow

To prepare and cut a release:

1. `leak-scan scan <repo> [--allow <file>]` -- check the history is clean
   before doing anything else. Fix any real hit with `history-rewrite replace`/
   `add-file --apply`, or add a known-good match to the allowlist.
2. `release-squash tail <repo> --tag=<tag> --message=<text> --apply` -- finish
   the release: one new anonymous, signed commit and tag in one step (or
   `release-squash apply` instead, if every commit up to HEAD is already tagged
   and only needs folding down).
3. Re-run `leak-scan scan` on the result, and check the tool's own `verify:`
   lines (tree delta, signatures, and for a squash, every commit tagged) --
   all three tools print these after every `--apply`.
4. Push manually. None of these tools pushes anything, ever.

## Rules and terms files

`--rules`, `--terms` and `--allow` files must live outside the target repo --
pointing one inside the repo is a refusal, not a warning: a file like that
would otherwise get committed the next time the repo's own history is
rewritten.

## Not in scope (v0.1)

Merge histories, rewriting commit messages, pushing, and project-specific
corpus splicing (use `--hook` for that).
