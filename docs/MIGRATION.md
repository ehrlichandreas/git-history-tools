# Migrating from v0.1 to v0.2

v0.2.0 renamed the three commands to the names their own docs already used in
prose. Nothing about their behaviour, flags or output changed — only the
command (and `bin/` file) name.

| Old | New |
|---|---|
| `ght-squash` | `release-squash` |
| `ght-scan` | `leak-scan` |
| `ght-rewrite` | `history-rewrite` |

Update any script, alias or muscle memory that names the old commands
directly, e.g. `sh bin/ght-squash tail ...` → `sh bin/release-squash tail ...`.
If you installed this package's `bin` entries (e.g. via `npm link`), re-link
after upgrading so the new command names are picked up.

Error messages printed by each tool are prefixed with its own command name
(e.g. `release-squash: HEAD is not tagged -- run 'tail' first`) — a script
that greps for the old prefix (`ght-squash: `, `ght-scan: `, `ght-rewrite: `)
needs updating too.

# Node.js ≥ 24 required (as of the TypeScript conversion, v0.2.x)

`lib/*.ts` and `test/**/*.ts` now run via Node's native TypeScript
type-stripping (no build step, no `tsx`) — this requires bumping
`engines.node` from `>=18` to `>=24`. If you're invoking these tools on an
older Node, upgrade first; there is no compiled/transpiled fallback.

# Migrating from v0.2 to v0.3

v0.3.0 prefixes all three commands with `git-`, so each one also works as a
`git` subcommand (an executable named `git-foo` on `PATH` is invocable as
`git foo`, per git's own subcommand convention — fitting, since these tools
operate on git history).

| Old | New |
|---|---|
| `release-squash` | `git-release-squash` |
| `leak-scan` | `git-leak-scan` |
| `history-rewrite` | `git-history-rewrite` |

Update any script, alias or muscle memory that names the old commands
directly, e.g. `sh bin/release-squash tail ...` → `sh bin/git-release-squash
tail ...`. If you installed this package's `bin` entries (e.g. via `npm
link`), re-link so the new names are picked up — and if `bin/` is on your
`PATH`, the commands are now also invocable as `git release-squash`, `git
leak-scan` and `git history-rewrite`.

Error messages printed by each tool are prefixed with its own command name
(e.g. `git-release-squash: HEAD is not tagged -- run 'tail' first`) — a
script that greps for the old prefix (`release-squash: `, `leak-scan: `,
`history-rewrite: `) needs updating too.
