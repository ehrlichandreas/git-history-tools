# git-history-tools

Tools for preparing a git history for publication while keeping every commit
signed:

- **git-release-squash** (`bin/git-release-squash`): reduce history to one commit per
  tag, optionally with anonymous dates (commit *i* at 1970-01-(*i*+1)
  12:00 UTC, signature time pinned). `tail --tag` cuts the next release in
  one step.
- **git-leak-scan** (`bin/git-leak-scan`): find emails, URLs, local paths, hostnames,
  IPs, secrets and your own terms anywhere in the history, including
  messages and identities.
- **git-history-rewrite** (`bin/git-history-rewrite`): replace text in, or add a file
  (e.g. a LICENSE) to, every commit.
- **git-sign** (`bin/git-sign`): policy-enforcing `commit`/`tag`,
  `resign-tags`/`resign-commits` to re-sign existing tags or a whole commit
  range without touching anything but the signatures, and `check` -- a
  read-only pre-push gate for identity, signature, forbidden time windows and
  forbidden message patterns (e.g. AI attribution lines). Identity, the
  signing key and the gpg binary come from a policy file, never from git
  config. `git-sign --help` lists every subcommand.
  Careful: `resign-commits <repo> <rev> --from-root` (a revision without
  `..`) re-signs every ancestor down to the root -- usually the whole
  history, which is why it refuses to run without `--from-root`; for the
  last N commits use `HEAD~N..HEAD`.

Every writing command is a dry run unless `--apply` is given. Commands that
rewrite existing history (`git-release-squash apply`/`tail`,
`git-history-rewrite`, `git-sign resign-tags`/`resign-commits`) write a
backup bundle first and verify the result afterwards. Nothing is ever pushed.

Requirements: Node.js ≥ 24, git and gpg. Every `--apply` of
git-release-squash and git-history-rewrite signs the commits and tags it
writes, and git-sign always uses gpg; only git-leak-scan never runs it.
There are no other dependencies.

```sh
sh bin/git-leak-scan scan ../my-repo --allow ~/my-public-identity.txt
sh bin/git-release-squash tail ../my-repo --name=my-repo --tag=v1.0 --message="first release"          # dry run
sh bin/git-release-squash tail ../my-repo --name=my-repo --tag=v1.0 --message="first release" --apply
```

Usage details are in [SKILL.md](SKILL.md) and the full contract is in
[docs/SPECIFICATION.md](docs/SPECIFICATION.md); what changed in each release
is in [docs/CHANGES.md](docs/CHANGES.md). Run the tests with
`node test/run-all.ts`. Their fixtures go under `/tmp`, or under
`GHT_TEST_ROOT=<dir>` if set; `GHT_KEEP=1` keeps them, and the run's own
root directory, for inspection. Files run in parallel, `--jobs=<n>` (or
`GHT_TEST_JOBS`) at a time, default up to 8; `--jobs=1` runs them one by
one, and `GHT_TEST_TIMES=<file>` writes each file's time there.

**v0.2.0** renamed the `ght-squash`/`ght-scan`/`ght-rewrite` commands to
`release-squash`/`leak-scan`/`history-rewrite`, and **v0.3.0** prefixed them
with `git-` (`git-release-squash`/`git-leak-scan`/`git-history-rewrite`) so
each one also works as a `git` subcommand (`git release-squash`, `git
leak-scan`, `git history-rewrite`) — see [docs/MIGRATION.md](docs/MIGRATION.md)
for the full old→new mapping. **v0.4.0** adds `git-sign`, with a policy file
at `docs/policy.example.json` showing the expected shape.

License: MIT.
