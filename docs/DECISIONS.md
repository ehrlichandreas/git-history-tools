# Decisions

## D1: Scope and shape (v0.1)

git-history-tools is a skill folder with three tools for preparing a git
history for publication. All three keep commits signed, and none of them
pushes.

**release-squash**
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

**leak-scan**
- `scan <repo> [--terms <file>]` searches every reachable blob, every
  commit and tag message, and every author/committer/tagger line.
- Built-in categories are emails, URLs, local home paths, hostnames, IPs,
  and secrets/private keys. The terms file adds the user's own
  case-insensitive terms, one per line.
- Output is one line per hit: category, match, count, and first
  commit:path.
- Exit status is 0 when clean, 1 on hits and 2 on usage errors.
- An allowlist file (`--allow <file>`) suppresses known-good matches.

**history-rewrite**
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
  - with replace, a leak-scan of the rule sources finds 0 hits.
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
commits using release-squash itself.

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
subcommand, including `history-rewrite`. Hashes for the report are
computed without `-w`, and trees with `mktree --missing`. A dry run leaves
`.git/objects` byte-identical.

**Test hygiene.**
- The test harness removes the backup bundles it causes; they sit next to
  the fixture repo, outside the tracked temp dirs.
- A repeat run of the suite leaves 0 files in the tmp root.
- A new AC pins plan/apply output for a single-commit group that carries
  two tags.
