# Ganban Sync — daemon + thin clients (Phase 1)

This documents the client/server refactor on the `feat/sync-daemon` branch: the Rust core is
lifted out of the Tauri shell into a shared crate, a headless daemon serves the database over
HTTP, and the clients (desktop + Android) talk to it.

## Architecture

```
crates/core   (ganban-core)  — shared data layer: sqlx pool + migrations (db.rs),
                                domain models (models.rs), error type (error.rs),
                                ALL business logic (ops.rs). Transport-agnostic.
        ▲                ▲
        │ desktop-only   │ always
        │                │
   src-tauri        crates/server (ganban-server)
   (desktop app)    (headless axum daemon)
        │                │
   thin Tauri          HTTP over the Tailscale tailnet
   commands              │
        │         ┌───────┴────────┐
   local SQLite   desktop client   Android client
   (gansty.db)    (Sync view)      (thin HTTP client, no DB)
```

- **One source of truth, one place for logic.** `ops.rs` holds every query; the Tauri commands
  and the daemon's HTTP handlers are thin adapters over it. No duplicated SQL/schema.
  *Since ADR 0001 (Oct 2026):* every command lives in one table in `crates/server/src/commands/`,
  with its access rule beside its handler. The daemon's `/invoke` and the desktop's one generic
  Tauri command (`run_command`, in-process) are its two adapters.
- **`sqlx` is desktop-only.** `src-tauri` depends on `ganban-core` (which pulls `sqlx`) only on
  non-mobile targets, so the Android build never compiles bundled SQLite (avoids the
  `__extenddftf2` NDK link error). On mobile the app is a pure HTTP client with no local DB.

## The daemon (`crates/server`)

```bash
cargo run -p ganban-server
```

- **Port / bind:** `0.0.0.0:8765` (so a phone on the tailnet can reach it). Override with
  `GANBAN_ADDR=0.0.0.0:9000`.
- **Database:** defaults to the desktop app's canonical file
  `<data_dir>/com.scs.gansty/gansty.db` (matches Tauri's `app_data_dir`). Override with
  `GANBAN_DB=/path/to/gansty.db`. The daemon **owns migrations**; clients never migrate.
- **No auth, permissive CORS** — trusted tailnet only. **Never** port-forward it to the public
  internet. Auth is a later phase.

### Endpoints (Phase 1: projects + tasks)

| Method | Path | Notes |
|--------|------|-------|
| GET    | `/health` | `{ status, version, service }` |
| GET    | `/projects` | list — **removed** |
| POST   | `/projects` | body = `CreateProjectInput` — **removed** |
| GET    | `/projects/:id` | one — **removed** |
| PATCH  | `/projects/:id` | body = `UpdateProjectInput` — **removed** |
| DELETE | `/projects/:id` | hard delete (matches desktop `delete_project`) — **removed** |
| GET    | `/tasks?project_id=&archived=` | list (omit `project_id` → all projects) — **removed** |
| POST   | `/tasks` | body = `CreateTaskInput` — **removed** |
| GET    | `/tasks/:id` | one — **removed** |
| PATCH  | `/tasks/:id` | body = `UpdateTaskInput` (incl. status changes) — **removed** |
| DELETE | `/tasks/:id` | soft delete / archive (matches desktop `delete_task`) — **removed** |
| GET    | `/snapshot` | `{ projects, tasks, counts }` — coarse read-through for the Sync view |

**Removed (Oct 2026, ADR 0001):** the owner-only `/projects` and `/tasks` CRUD routes. Nothing
had used them since the clients moved to `/invoke` in June; their commands (`get_projects`,
`create_task`, …) are in the command table, where members get the same access rules as every
other command. `/snapshot` stays for the Sync view.

Errors: `NotFound`/row-missing → 404, `InvalidInput` → 400, else 500, body `{ "error": "..." }`. A refusal the client acts on (`Refused`, also 400) adds a stable `code`, e.g. `{ "error": "...", "code": "AI_FILE_TOO_LARGE" }`.

## The transport seam (`src/lib/`)

`src/lib/api.ts` is the **only** place that decides where data comes from. The ~70 exported
functions are unchanged; `invokeWithLogging` routes:

- **Mobile** → HTTP (`httpInvoke` maps the projects/tasks commands to the REST endpoints above).
- **Desktop** → local Tauri `invoke` (unchanged — no regression). The read-only **Sync view**
  (`src/components/SyncView.tsx`) talks to the daemon directly via `src/lib/daemon.ts`; the rest of
  the desktop app stays local. Routing the whole desktop app through the daemon is a later phase.

`src/lib/daemon.ts` holds the daemon base URL (persisted in `localStorage`), platform detection
(`isMobilePlatform()` — webview UA, plus a `?mobile=1` / `localStorage['ganban-force-mobile']='1'`
dev override to exercise the mobile UI in a desktop browser), `daemonFetch`, `checkHealth`,
`getSnapshot`.

Commands not yet on the daemon (areas, time entries, comments, events, contacts, users, …) throw a
clear "not available over HTTP yet" error if called on mobile — the mobile UI only uses
projects/tasks.

## Clients

- **Desktop "Sync" view** — new sidebar item. Enter the daemon URL, Connect (`GET /health`), then
  view the DB fetched over HTTP (projects with task counts + a tasks table), with connection
  status, last-synced time, and Refresh.
- **Mobile** (`src/MobileApp.tsx`, chosen in `main.tsx` on mobile) — connect screen → single-column
  project list → a project's tasks, with create/read/update/delete for both. Deliberately plain,
  touch-first, no drag-and-drop.

## Android

```bash
npm run tauri android init          # already run; scaffold in src-tauri/gen/android
npm run tauri android build -- --debug --target aarch64 --apk   # build an APK
npm run tauri android dev           # run on a connected device/emulator
```

- Identifier `com.scs.gansty`, minSdk 24, targetSdk 36.
- **Cleartext HTTP** is enabled in `app/build.gradle.kts` (`usesCleartextTraffic=true`) because the
  daemon is plain HTTP on the tailnet; Android blocks cleartext by default on API 28+. Tighten with
  TLS / a network-security-config when auth lands.
- **CSP** is `null` in `tauri.conf.json`, so nothing blocks the webview `fetch` to the daemon. If a
  CSP is added later it must allow the daemon origin in `connect-src`.

## Phase 1 status

Verified here:
- `cargo build` (whole workspace) and `npm run build` succeed; desktop Rust is intact.
- Daemon serves the full project/task CRUD lifecycle (curl-tested).
- `cargo tree --target aarch64-linux-android` shows **no** sqlx/ganban-core; the aarch64 APK builds
  and links `libgansty_lib.so` with no `__extenddftf2`.

Needs your hardware (can't be done headless): `npm run tauri android dev` installing and running on a
connected device, and visually confirming the mobile CRUD against a live daemon.

## Desktop-only / flagged for later

- `export_database` / `import_database` — copy the SQLite file via the Tauri `AppHandle` + native
  dialogs; desktop-only, not exposed by the daemon.
- `verify_file_attachment` — checks the **local** filesystem (`Path::exists`); meaningless against a
  remote daemon. Kept desktop-only.

## Out of scope (later phases)

Auth/sessions, offline cache + conflict resolution, write-CRUD for the remaining entities, routing
the desktop app fully through the daemon, public/multi-tenant access.
