# One command table; the desktop runs it in-process; no access rule means denied

Every command lives in one table in the server crate, grouped by entity. Each entry declares its access rule, result
filter, authorship field and handler, with every argument key named once. The table replaces the separate `authorize`,
`post_scope` and `dispatch` matches and the admin, self-service and storage dispatchers. The host's HTTP `/invoke` and
the desktop app are two adapters over it. The desktop runs it in-process through one generic Tauri command, as the
owner, with authorship from the selected local profile. That's why the desktop path skips access rules. A command with
no access rule is refused, and a test fails if any command lacks one.

## Considered options

- **Desktop over loopback HTTP to its own embedded daemon:** rejected. Every local call would pay HTTP, and local mode
  would break whenever the daemon is down.
- **Typed argument structs per command:** rejected for now. About 155 structs is a much bigger change than naming each
  key once in its table entry.
- **Default-allow plus a test:** rejected. A skipped test would leave the next command open to every member.

## Consequences

The 138 pass-through functions in `src-tauri/src/commands.rs` and their registrations go away. Desktop-only operations
(database export/import, local file reads, storage paths, file sync) remain bespoke Tauri commands. The unused REST
routes `/projects` and `/tasks` are removed; `/snapshot` stays. Agent tools (`tools.rs`) stay a separate, curated
interface.
