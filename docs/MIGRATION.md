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

# Migrating from v0.3 to v0.4

v0.4.0 adds `git-sign` and keeps the three existing commands' names, flags
and output — with one exception, in the flag parser all four tools share
(D17).

A value flag still takes its value either as `--flag=<value>` or as the next
argument (`--flag <value>`). What changed: in the space-separated form, a
next argument that itself starts with `--` is no longer taken as the value.
It used to be, silently — `git-leak-scan scan <repo> --terms --allow <f>`
read `--allow` as the terms file and never saw an allowlist;
`git-release-squash tail <repo> --tag=v1 --message --apply` made `--apply`
the tag message and stayed a dry run. Both are now the usage error
`<bin>: missing value for --terms` / `--message` (exit 2), nothing done.

Affected value flags: `--name`, `--map`, `--dates`, `--tag`, `--message`,
`--message-file` (`git-release-squash`); `--terms`, `--allow`
(`git-leak-scan`); `--rules`, `--hook`, `--as` (`git-history-rewrite`).

What a caller has to change:

- A call that left a value flag's value out by mistake now fails with exit
  2 instead of misreading the next flag — give the value.
- A value that really starts with `--` (a message such as `--apply`, a path
  such as `--odd-name`) must be written as `--flag=<value>`:
  `--message=--apply`. `--flag=<value>` works for every value, so scripts
  that always use it need no change at all.
- A script that treated exit 0/1 as the only outcomes of these calls should
  expect exit 2 (usage error, nothing changed) here, as for any other bad
  flag.

`git-sign` is new in v0.4.0 and has no earlier public form, so nothing about
it needs migrating.

# Migrating from v0.4.4 to v0.4.5

Three calls that used to go through, or crash, are now the usage error
(exit 2, one stderr line, nothing done), as in the v0.4 change above:

- A positional argument the subcommand does not take, e.g. a typo after
  `--apply`: `<bin>: unexpected argument: <arg>`. git-release-squash,
  git-history-rewrite and git-leak-scan ignored it and ran; git-sign
  already refused it (D23).
- A `--message-file`, `--rules`, `--terms`, `--allow` or add-file `<path>`
  that is missing, a directory or unreadable: `<bin>: <flag>: no such
  file|is a directory|permission denied: <path>`. It was a node stack
  trace, exit 1.
- A `--message-file` that is not valid UTF-8: `<bin>: --message-file: not
  valid UTF-8: <path>`. Its bytes were written as U+FFFD.

A script that treated exit 0/1 as the only outcomes should expect exit 2
here. And every `--apply` that writes a backup bundle now prints `backup:
<path>` as its first stdout line, also before a refusal; a script that
expected no stdout from such a refusal sees this line.

`git-release-squash plan` prints what § 1.1 always said: `into "<name>
<tag>: <title>"` instead of `into "<title>"`, and as `<tag-short>` the
preview sha of the squash commit `apply` would build, not the tag's own
sha. A script that read either from `plan`'s output has to change.

In a repository with `i18n.commitEncoding` set, the commits ght writes no
longer carry an `encoding` header. Their bytes are UTF-8, as before; only
the wrong label is gone. A source commit with an explicit `encoding
UTF-8` header loses it in `replace`, and `resign-commits` refuses it
(exit 1, nothing written) instead of moving the ref and failing its
verify; run `replace` first to drop the header.

# Migrating from v0.4.5 to v0.4.6

A script that assumed a FAILED verify line on `resign-commits --apply`,
`apply --apply`, `tail --apply`, `replace --apply` or `add-file --apply`
always meant the refs had already moved (the backup bundle the only way
back) can no longer assume that. `tree delta`, and for `resign-commits`
also `headers preserved`/`parents mapped`/`check (signature/sig-time)`,
are now checked before the ref transaction: a FAILED one there is exit 1
with no ref moved at all, same as any other refusal after the bundle. A
script that recovers from one of these exits by restoring the bundle
still works (the bundle is still there, unchanged), but one that
*assumed* it was necessary should check whether any ref actually moved
first (`git for-each-ref`) rather than restoring unconditionally.

Only `signatures` and, for `apply`, `every commit tagged` still mean the
refs moved when they FAIL. On success, output is byte-identical to
v0.4.5.
