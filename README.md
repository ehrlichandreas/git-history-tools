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

Every writing command is a dry run unless `--apply` is given. `--apply`
writes a backup bundle first and verifies the result afterwards. Nothing is
ever pushed.

Requirements: Node.js ≥ 24 and git, plus gpg if the commits are signed.
There are no other dependencies.

```sh
sh bin/git-leak-scan scan ../my-repo --allow ~/my-public-identity.txt
sh bin/git-release-squash tail ../my-repo --name=my-repo --tag=v1.0 --message="first release"          # dry run
sh bin/git-release-squash tail ../my-repo --name=my-repo --tag=v1.0 --message="first release" --apply
```

Usage details are in [SKILL.md](SKILL.md) and the full contract is in
[docs/SPECIFICATION.md](docs/SPECIFICATION.md). Run the tests with
`node test/run-all.ts`.

**v0.2.0** renamed the `ght-squash`/`ght-scan`/`ght-rewrite` commands to
`release-squash`/`leak-scan`/`history-rewrite`, and **v0.3.0** prefixed them
with `git-` (`git-release-squash`/`git-leak-scan`/`git-history-rewrite`) so
each one also works as a `git` subcommand (`git release-squash`, `git
leak-scan`, `git history-rewrite`) — see [docs/MIGRATION.md](docs/MIGRATION.md)
for the full old→new mapping.

License: MIT.
