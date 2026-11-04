# Environment variable reference

Everything `ganban-server` and the `ops/` scripts read from the environment. Setup steps are in
[SELF_HOSTING.md](SELF_HOSTING.md).

`<app dir>` below is the folder that holds the database:

- macOS: `~/Library/Application Support/com.scs.gansty/`
- Linux: `~/.local/share/com.scs.gansty/` (or `$XDG_DATA_HOME/com.scs.gansty/`)

The folder name is the app's bundle id. It is the same folder the desktop app uses, so a server and a desktop app on
the same machine share one database (run only one of them at a time).

## ganban-server

Settings saved in the app (stored in the database) win over these. The variables are the fallback for a fresh
database or a headless host.

| Variable | Default | What it does | Read in |
|----------|---------|--------------|---------|
| `GANBAN_DB` | `<app dir>/gansty.db` | Full path to the SQLite database | `main.rs` |
| `GANBAN_ADDR` | `0.0.0.0:8765` | Where the server listens. Must be `IP:PORT`; a bare port or a host name stops it at start | `main.rs` |
| `GANBAN_STORAGE` | `<folder of the DB>/shared` | Where uploaded files are kept | `main.rs` |
| `GANBAN_LOG_DIR` | `<folder of the DB>/logs` | The server's daily log files | `main.rs` |
| `GANBAN_WEB_DIR` | the checkout's `dist/`, else the copy built in with `--features embed-web` | The web UI folder the server serves | `lib.rs` |
| `GANBAN_SHARE_ADDR` | none (no share door) | The share door's address, e.g. `127.0.0.1:8770`. It serves only share links, and it's the one port you publish with Funnel | `share/mod.rs` |
| `GANBAN_SHARE_URL` | none (links show no public URL) | The door's public address, e.g. `https://<machine>.<tailnet>.ts.net` | `share/mod.rs` |
| `GANBAN_OLLAMA_URL` | `http://127.0.0.1:11434` | Ollama's address, until one is saved in Settings → AI Engines | `ollama.rs` |
| `GANBAN_CHAT_MODEL` | `llama3.1:8b` | The chat model when no personality or chat model is chosen in Settings | `lib.rs` |
| `GANBAN_CHAT_TEMPERATURE` | none | Chat temperature fallback | `lib.rs` |
| `GANBAN_CHAT_MAX_TOKENS` | none | Chat max-tokens fallback | `lib.rs` |
| `GANBAN_CHAT_SYSTEM_PROMPT` | the built-in prompt | Chat system-prompt fallback | `lib.rs` |
| `GANBAN_ANDROID`, `GANBAN_WINDOWS`, `GANBAN_MACOS`, `GANBAN_LINUX`, `GANBAN_SERVER` | none | Paths to app installers (and a server build) offered at `/download` | `main.rs` |
| `GANBAN_APP_DIR` | the folder of `GANBAN_DB` | Where `client-builds/` and `update-status.json` live | `updates.rs` |
| `GANBAN_LOGS` | `~/Library/Logs/ganban` | Where `ops/update.sh` writes `update.log` (read by the Update the server button) | `updates.rs` |
| `LAUNCHCTL` | `/bin/launchctl` | The `launchctl` the Update the server button runs (for tests) | `updates.rs` |
| `GANBAN_SSE_RENEW_SECS` | `600` | How often the live-update stream reconnects (for testing) | `lib.rs` |
| `GANBAN_PI_UNSANDBOXED` | none | Linux only: set to `1` to let pi runs go without a sandbox when Bubblewrap (`bwrap`) isn't installed. Without it such a host refuses pi runs. The run can then read everything you can | `pi_rpc.rs` |
| `PI_CODING_AGENT_DIR` | `~/.pi/agent` | pi's config folder, where Ganban copies a run's model settings and key from | `pi_rpc.rs` |

### Knowledge base (ragrat): coming later

ragrat, the knowledge-base engine behind Atlas and the AI overview, isn't published yet. Ganban works fully without it;
those screens say "not set up". These variables are for when it is available:

| Variable | Default | What it does |
|----------|---------|--------------|
| `GANBAN_RAGRAT_URL` | none (knowledge base off) | ragrat's address, until one is saved in Settings → AI Engines |
| `GANBAN_RAGRAT_TOKEN` | none | ragrat's service token, if it has one |
| `GANBAN_RAGRAT_STAGING` | `<app dir>/rag/staging` | Where each project's text and files are staged for indexing |
| `GANBAN_RAGRAT_OUT` | `<app dir>/rag/collections` | Where ragrat writes its indexes |
| `GANBAN_RAGRAT_POLL_SECS` | `900` (values under 30 are ignored) | How often changed projects are re-indexed |

## Settings stored in the database

Written from the app's Settings by the host's owner. They win over the variables above.

| Key | Shape | Set from |
|-----|-------|----------|
| `ollama_connection` | `{"base_url": "..."}` | AI Engines → Ollama |
| `ragrat_connection` | `{"url": "...", "token": "..."}` | AI Engines → ragrat |
| `chat_profile` | `{"model", "temperature?", "max_tokens?", "system_prompt?"}` | Models → Chat model |
| `rag_embedding` | `{"endpoint", "model", "dimensions"}` | Models → Embedding model |
| `ai_active_profile_id` | `"<id>"` | Personalities → Activate |
| `model_profiles` (a table) | one row per personality | Personalities → Save |

## The ops/ scripts (macOS service)

`ops/install.sh` keeps its answers in `<app dir>/install.env`, and `ops/update.sh` reads them from there.

| Variable | Default | What it does |
|----------|---------|--------------|
| `GANBAN_APP_DIR` | `~/Library/Application Support/com.scs.gansty` | The folder holding `gansty.db`, `backups/`, `keys/`, `client-builds/` |
| `GANBAN_LOGS` | `~/Library/Logs/ganban` | The service's stdout, stderr and `update.log` |
| `GANBAN_SHARE_ADDR`, `GANBAN_SHARE_URL` | the last install's | Same as above; `ops/install.sh --share-addr`/`--share-url` set them |
| `GANBAN_CLIENT_BUILDS` | `desktop,android` | Which client apps `ops/update.sh` builds: `desktop`, `android`, both, or `none` |
| `GANBAN_CLIENT_FULL` | unset | `1` adds the engine bundle to the desktop build |
| `GANBAN_UPDATER_KEY`, `GANBAN_ANDROID_KEYSTORE_PROPS` | `<app dir>/keys/updater.key`, `<app dir>/keys/keystore.properties` | Where the client builds find their signing keys, if not in `keys/`. `GANBAN_UPDATER_KEY_PASSWORD` overrides `keys/updater.pass` |
| `ANDROID_HOME`, `NDK_HOME`, `JAVA_HOME` | from your shell | The Android toolchain; `ops/install.sh` copies them into the updater's job |
| `GANBAN_HEALTH_WAIT` | `30` | Seconds the scripts wait for `/health` after a restart |

For tests only: `GANBAN_GATE_MODEL` (the pi sandbox tests), `LAUNCHCTL`, `LSOF`, `TAILSCALE`, `AGENTS_DIR`, `SQLITE3`, `GANBAN_SKIP_BUILD=1`.

`ops/backup.sh` reads only `GANBAN_APP_DIR` (and `SQLITE3`), so on Linux run it as
`GANBAN_APP_DIR=~/.local/share/com.scs.gansty ops/backup.sh`.
