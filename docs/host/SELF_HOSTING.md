# Self-hosting Ganban

This guide sets up **your host**: one always-on computer (a Mac or a Linux machine) that runs Ganban's server and
keeps the database. Your laptop, your phone and anyone you invite then connect to it over
[Tailscale](https://tailscale.com), a private network between your own devices.

In the commands below, `$REPO` is the folder where you cloned Ganban, for example:

```bash
git clone <ganban repo URL> ~/ganban
export REPO=~/ganban
```

Every environment variable is listed in [ENV_REFERENCE.md](ENV_REFERENCE.md).

---

## What runs where

| Process | Listens on | Reachable from your devices? | Role |
|---------|------------|------------------------------|------|
| **ganban-server** | `0.0.0.0:8765` | **Yes**, over Tailscale | The Ganban host. Serves the app, the API and the web UI |
| **Ollama** | `127.0.0.1:11434` | No (this machine only) | Runs the AI models: chat and embeddings |
| **ragrat** (coming later) | `127.0.0.1:8780` | No (this machine only) | The knowledge base. Optional; see [Knowledge base](#knowledge-base-ragrat-coming-later) |

ganban-server is the only thing your devices talk to. It reaches Ollama (and later ragrat) on the host's own loopback,
so clients never see those addresses or any token.

```
   laptop app  ─┐                                    ┌──────────── your host ────────────┐
   phone app   ─┼──►  http://<100.x.y.z>:8765  ──►   │  ganban-server :8765              │
   browser     ─┘     (over Tailscale)               │      └──► Ollama :11434 (loopback) │
                                                     └───────────────────────────────────┘
```

**Security model.**

- ganban-server belongs on your tailnet only. **Never port-forward it to the public internet, and never Funnel the
  main port.** The one part you may publish is the share door ([Share links](#share-links)).
- Requests from the host itself (`127.0.0.1`) count as the host's owner, with no token. That's why the desktop app on
  the host can change settings, and why `scripts/pair-link.sh` works.
- Every other device pairs once and gets a **device token**. Device tokens don't expire: a paired device stays trusted
  until you revoke it, like an SSH key. Revoke lost devices from the devices lists ([§4.3](#43-one-person-many-devices)).
- The pairing codes themselves are single-use and expire after about 24 hours.

---

## Before you start

- **A host:** a Mac with Apple Silicon, or a Linux machine, that stays on. (An Intel Mac may still build and run the
  host from source, but it isn't tested.)
- **Tailscale** installed and signed in on the host *and* on every client. Turn on MagicDNS if you want HTTPS or
  share links.
- **Ollama** (<https://ollama.com>) on the host, for the AI assistant. Ganban works without it, minus the assistant.
- **Rust** (`cargo`) and **Node.js** with `npm`, to build the server and the web UI.
- **sqlite3** on the host, for backups.

The service scripts in `ops/` are written for **macOS** (they use launchd). On Linux you run the same server with a
systemd unit you write yourself; the steps are below, and they're marked where they differ.

---

## Part 1: Set up the host

### 1.1 Build the server and the web UI

```bash
cd $REPO
npm ci
npm run build                            # the web UI, into $REPO/dist
cargo build --release -p ganban-server   # the server, into $REPO/target/release/ganban-server
```

The server looks for the web UI in this order: `GANBAN_WEB_DIR`, then the `dist/` of the checkout it was built in,
then a copy built into the binary. For one self-contained binary you can copy anywhere, build with
`cargo build --release -p ganban-server --features embed-web` after `npm run build`.

On macOS, `ops/install.sh` (§1.4) does this build for you, so you can skip ahead.

### 1.2 Ollama

Start Ollama and pull a chat model and an embedding model:

```bash
ollama serve                 # on macOS the Ollama app starts it for you
ollama pull llama3.2
ollama pull nomic-embed-text
```

> **Pick the model you pulled.** If nothing is chosen in Settings, Ganban asks Ollama for **`llama3.1:8b`**. If you
> pulled a different model, choose it in Settings → Models (§3.2), or set `GANBAN_CHAT_MODEL`. Otherwise chat fails.

Keep Ollama running all the time: on macOS the Ollama app starts at login; on Linux the Ollama installer sets up a
systemd service. It only needs loopback.

### 1.3 A first run

Try the server in a terminal first:

```bash
cd $REPO
GANBAN_ADDR=0.0.0.0:8765 ./target/release/ganban-server
```

It opens (or creates) the database at:

- macOS: `~/Library/Application Support/com.scs.gansty/gansty.db`
- Linux: `~/.local/share/com.scs.gansty/gansty.db`

That's the same database the desktop app uses on that machine, so settings made in the app carry over. Set
`GANBAN_DB` to use another file. `GANBAN_ADDR` must be `IP:PORT`; a bare port or a host name stops the server at start.

`npm run serve:headless` does the same with the desktop app's paths spelled out (on Linux, set
`GANBAN_APP_DIR=~/.local/share/com.scs.gansty`).

**The first-start token.** When no owner device is paired yet, the server prints a one-time owner enrollment token
(valid about 24 hours). You usually don't need it: the host itself counts as the owner, so you pair devices from the
app (Part 4) or with `scripts/pair-link.sh`.

Stop it with Ctrl-C once `curl http://127.0.0.1:8765/health` answers.

> **Only one at a time.** The desktop app runs its own server on port 8765 and writes the same database. On the host,
> run either the desktop app or ganban-server, never both.

### 1.4 Run it as a service: macOS

`ops/install.sh` installs the server as a LaunchAgent. It then runs all the time: at login, and again 10 seconds after
a crash.

```bash
cd $REPO && ops/install.sh       # --addr IP:PORT, --client-builds none|desktop|android|desktop,android, --force, --dry-run; see --help
```

- **The service.** `com.ganban.server` runs `$REPO/live/ganban-server` and serves the web UI from `$REPO/live/dist/`.
  On the first install the script builds both (`ops/build.sh`) and smoke-tests them on a throwaway database
  (`ops/smoke.sh`). Its `PATH` includes Homebrew's folders and `pi`'s, so member agents find `pi` and `node`.
- **Quit the desktop app first.** The install refuses while another process holds the port or the database, and names
  it. `--force` installs anyway. Keep the desktop app closed on the host while the service runs.
- **Nightly backups.** `com.ganban.backup` runs `ops/backup.sh` at 03:30 ([Backups](#part-7-backups-and-restore)).
- **The updater.** `com.ganban.updater` runs `ops/update.sh` when the **Update the server** button asks for it
  (Part 6). Its `PATH` holds `node`, `npm`, `git` and `cargo`; launchd keeps what it prints in
  `~/Library/Logs/ganban/updater.out.log`.
- **Logs.** The server's daily log is in `~/Library/Application Support/com.scs.gansty/logs/`. Its stdout goes to
  `~/Library/Logs/ganban/server.log`, and early crashes to `server.err.log`.
- **Running it again** is safe: it re-renders the plists from `ops/launchd/`, restarts the service and waits for
  `/health`. Your answers are kept in `com.scs.gansty/install.env`.
- **Stop it:** `launchctl bootout gui/$(id -u)/com.ganban.server` (it starts again at the next login).
  **Start it:** `ops/install.sh`.
- **Older setups.** A `com.scs.gansty.headless` agent from an older version is stopped and its plist moved aside, and
  a hand-made `com.ganban.server` is replaced.

### 1.5 Run it as a service: Linux

`ops/install.sh`, `ops/update.sh` and the Update the server button need launchd, so they don't work on Linux. The server
itself runs fine; keep it running with a systemd **user** unit. This is an example, not something the project ships
or tests, so adjust the paths:

```ini
# ~/.config/systemd/user/ganban.service
[Unit]
Description=Ganban host server
After=network-online.target

[Service]
WorkingDirectory=%h/ganban
Environment=GANBAN_ADDR=0.0.0.0:8765
# Member agents need pi and node on the PATH; add their folders here.
Environment=PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=%h/ganban/target/release/ganban-server
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now ganban
loginctl enable-linger "$USER"     # keep it running when you're not logged in
journalctl --user -u ganban -f     # its output
```

For nightly backups, add a cron line (`crontab -e`):

```
30 3 * * * GANBAN_APP_DIR=$HOME/.local/share/com.scs.gansty $HOME/ganban/ops/backup.sh
```

(cron sets `$HOME` but doesn't know `$REPO`, so write the checkout's path out.)

To update on Linux, see [Without the service](#without-the-service).

### 1.6 Or: the desktop app as the host

Instead of the service you can simply run the **desktop app** on the host and turn on **Settings → Sync → Host this
device**. It runs the same server on port 8765 against the same database. It stops when you quit the app, so the
service is the better choice for a host that should always answer.

---

## Part 2: Get the host's address

Bring the host onto your tailnet once, then read its address:

```bash
tailscale up                                     # once; or use the Tailscale app
tailscale ip -4                                  # -> 100.x.y.z
tailscale status --json | jq -r '.Self.DNSName'  # -> <machine>.<tailnet>.ts.net. (drop the last dot)
```

Clients connect to `http://100.x.y.z:8765` or `http://<machine>.<tailnet>.ts.net:8765`. The desktop app's **Sync →
Host this device** view lists these addresses (Tailscale first, then your LAN) with a QR code, so you rarely type them.

**Optional HTTPS** for the main port, private to your tailnet:

```bash
tailscale serve --bg 8765    # https://<machine>.<tailnet>.ts.net -> 127.0.0.1:8765
                             # needs MagicDNS and HTTPS certificates on in the Tailscale admin console
```

Plain `http://` works for phones and browsers on the tailnet. HTTPS adds the live QR scanner and the share sheet in
browsers, which only work on secure pages.

---

## Part 3: Set up the AI (Settings)

> **Save AI settings on the host.** They're stored in the host's database and only the owner can change them. A
> desktop app in **local** mode saves to its own machine's database instead. So enter them either in the desktop app
> on the host, or from a desktop that's connected to the host in **online** mode (paired, Part 4).

### 3.1 AI Engines

**Settings → AI Engines → Ollama (local model engine):** the URL is `http://127.0.0.1:11434`. Press **Test**
("Connected — N model(s) available"), then **Save**. Saving applies at once, without restarting the server.

The **ragrat (knowledge base)** card can stay empty: see [Knowledge base](#knowledge-base-ragrat-coming-later).

### 3.2 Models

- **Pull a model:** type `model:tag` (e.g. `llama3.2`) and press **Pull**. The host downloads it and shows progress.
- **Chat model:** choose the model you pulled (press **Refresh** to reload the list). Temperature and Max tokens are
  optional. Press **Save**.
- **Embedding model:** `nomic-embed-text` by default. **Check** shows its dimension count (768 for
  `nomic-embed-text`). **Save & re-index** saves it and rebuilds the knowledge-base indexes. Re-index every time you
  change the embedding model, or search results stop making sense.

### 3.3 Personalities

**Settings → Personalities** holds named profiles: a name, a model, a system prompt, temperature and max tokens.
**Activate** one to make it the assistant's default. With none active, the assistant uses the chat model from §3.2,
then `GANBAN_CHAT_MODEL`, then `llama3.1:8b`.

---

## Part 4: Connect your devices

Every client ends up with its own device token. None of them sees the Ollama address.

### 4.1 On the host: make a pairing link

In the desktop app on the host: **Settings → Sync → Host this device → Start**. It shows **Reachable at** with the
detected addresses; use the Tailscale one.

- **Your own phone or laptop:** **Pair a phone** shows a QR code and a **Copy invite link** button
  (`<address>/#invite=<TOKEN>`).
- **Someone else:** **Invite to a project…** → pick the project and a role (member or admin) → **Generate invite QR**.

**A host with no screen** (the service, over SSH) has no Sync view. Use the helper instead. It asks the server over
loopback, so it needs no password, and it fills in the Tailscale address:

```bash
cd $REPO
./scripts/pair-link.sh                              # a pairing link for your own device
./scripts/pair-link.sh --project 3 --role member    # invite someone to project 3
ssh you@your-host 'cd ~/ganban && ./scripts/pair-link.sh'   # or from your laptop
```

It prints `http://<tailnet address>:8765/#invite=<TOKEN>`. `--host` and `--port` override the address. Like the
app's links, it's single-use and expires after about 24 hours.

### 4.2 On the client: join

- **Desktop app:** **Settings → Sync → Run as a client of a host** → paste the link → **Connect (online mode)**. From
  then on, settings you save there go to the host. If a downloaded app won't open on a Mac ("…is damaged"), run
  `xattr -cr /Applications/Ganban.app` once (see [BUNDLING.md](BUNDLING.md)).
- **Android app:** scan the QR code.
- **Browser (no app):** open the link. The token sits after the `#`, so it never reaches the server's logs.

**A browser gets the full app.** With a mouse and a window at least 760 px wide it shows the desktop layout; on a phone,
a touch screen or a narrow window it shows the touch layout. Change it in **Settings → Design → Interface**, or with
`?shell=desktop` / `?shell=touch`.

What a browser doesn't get, because it belongs to the machine holding the database: AI Engines, Data & Storage,
Updates, Sync and pairing, path-based file links ("Add Files" on a task) and the demo recorder. Uploads, downloads and
opening files all work.

### 4.3 One person, many devices

A person is one account with any number of devices. Each browser or app pairs once and keeps its own token, and that
token never expires. Revoking is how you take access away:

- **Your own devices:** Settings → Profile → **Your devices** (touch layout: More → Account → Your devices). Remove a
  device you no longer have, or **Pair another device**.
- **A member's devices** (owner): Sync → Members → *Devices* → **Revoke**. The device is signed out on its next request
  and shows "signed out by the host".

**Adding a device you own.** On any signed-in device, **Pair another device** makes a one-time code tied to your
account, shown as a code, a link and a QR code. Use whichever fits:

- **A computer with the Ganban app:** open Ganban → **Join a project** → paste the *link*. (Don't click the link there:
  that opens a browser tab, which is a separate client.)
- **A computer, browser only:** open the link.
- **An iPhone Home Screen app:** paste the code or link on its Join screen, or tap **Scan QR**.
- **The Android app:** scan the QR code.

The new device signs in as you: same projects, same history.

**Getting back in with no signed-in device left.** The owner opens the project's **Members** tab → the person → **Pair
a device…** (or **Contacts** → the person → **Pair a new device**). That makes the same kind of code, for them. Don't
re-invite them: an invite creates a new account, so it's refused for someone who already has one.

**iPhone "Add to Home Screen"** makes a separate app with its own storage. It doesn't share the Safari tab's sign-in,
so pair it like another device: in the Safari tab, Account → Your devices → Pair another device → Copy, then paste it
on the Home Screen app's Join screen. That screen detects a Home Screen launch and shows these steps.

**Scan QR on the Join screen** uses a live viewfinder when the host is on HTTPS (`tailscale serve`, Part 2), and
"Take a photo of the code" over plain HTTP.

---

## Part 5: Check that it works

On the host:

```bash
curl http://127.0.0.1:11434/api/tags      # Ollama
curl http://127.0.0.1:8765/health         # ganban-server: {"status":"ok","version":"...","service":"ganban-server"}
```

From a client, over Tailscale:

```bash
curl http://100.x.y.z:8765/health
```

Then open the **Assistant** in the app and ask it something.

---

## Share links

A **share link** gives someone outside your team a task's files over the internet: no account, an expiry (7 days by
default), an optional password, a download count, and you can revoke it. The recipient gets a small page with the
file list, **Download all (.zip)** and a download per file; both resume after a dropped connection.

Links are served by the **share door**: a second listener in the same server that answers only `/s/<token>` pages and
downloads. It has no API and accepts no device tokens. Only the door is published to the internet, with
`tailscale funnel`; the main port stays on your tailnet. TLS ends on your host, so files go straight from it to the
recipient.

On the host, three steps:

1. **Tell the server where the door is.** On macOS, reinstall with the door's address and public URL (they're kept for
   later installs and updates):

   ```bash
   cd $REPO && ops/install.sh --share-addr 127.0.0.1:8770 --share-url https://<machine>.<tailnet>.ts.net
   ```

   `--share-addr off` closes the door. On Linux, add `GANBAN_SHARE_ADDR=127.0.0.1:8770` and
   `GANBAN_SHARE_URL=https://<machine>.<tailnet>.ts.net` to the unit's `Environment=` lines and restart it.
   `<machine>.<tailnet>.ts.net` is the MagicDNS name from Part 2, without the trailing dot.
2. **Turn on HTTPS and Funnel for your tailnet.** In the Tailscale admin console, turn on MagicDNS and HTTPS
   certificates (DNS page), and allow Funnel in the access-control policy with a `funnel` node attribute:

   ```json
   "nodeAttrs": [{ "target": ["autogroup:member"], "attr": ["funnel"] }]   // or a tag on the host only
   ```
3. **Publish the door, and only the door:**

   ```bash
   tailscale funnel --bg 8770      # https://<machine>.<tailnet>.ts.net:443 -> 127.0.0.1:8770
   tailscale funnel status         # check: only 8770 is listed
   ```

Without `GANBAN_SHARE_URL`, links can still be made but show no public URL. Without `GANBAN_SHARE_ADDR` there's no
door, and the app says so. Test from outside your tailnet (a phone on mobile data):
`https://<machine>.<tailnet>.ts.net/s/x` shows "This link isn't available", and anything outside `/s/` is a bare 404.
The host log records each download and where it came from (`share door: …` lines). Tailscale caps Funnel's bandwidth,
so big downloads can be slower than your upload speed. The design is in
[SHARE_LINKS.md](../design/SHARE_LINKS.md).

---

## Part 6: Updating the host

### On macOS, with the service

```bash
cd $REPO && ops/update.sh        # --dry-run prints the steps
```

In order, it:

1. checks that nothing else (the desktop app?) holds the port or the database;
2. pulls (`git pull --ff-only`), runs `npm ci` and the checks (`tsc`, and `cargo test` for core and server);
3. builds the server and the web UI together into `live.next/`, and smoke-tests that build on a throwaway database;
4. backs up the database, because the new server may migrate it;
5. swaps `live.next/` in as `live/`, restarts the service and waits until `/health` reports the new build.

It ends with one line: `ganban updated <old> → <new>: build …, healthy; backup …`.

It stops at the first failure. Before the swap, nothing you run has changed, so there's nothing to undo. If the new
build doesn't come up healthy after the swap, the script rolls back by itself: it puts `live.prev/` back, restarts the
service and keeps the failed build as `live.bad/`. If the old build doesn't come up either, it names the backup to
restore ([Part 7](#part-7-backups-and-restore)). After a good update, the replaced build stays in `live.prev/` until
the next one. To go back to it by hand:

```bash
mv live live.bad && mv live.prev live && launchctl kickstart -k gui/$(id -u)/com.ganban.server
```

Run `ops/install.sh` again after an update that changes `ops/launchd/`.

**If it fails,** read its whole output and `git log --oneline -3`. The service's output is in `~/Library/Logs/ganban/`
and its daily log in `~/Library/Application Support/com.scs.gansty/logs/`.

**From the app:** **Settings → Updates → Update the server** (the host's owner only) does the same. The server can't run the update
itself (the update restarts it), so it starts `com.ganban.updater`, a LaunchAgent that runs only when asked. While it
runs, `ops/update.sh` writes its progress to `~/Library/Application Support/com.scs.gansty/update-status.json` and
everything it prints to `~/Library/Logs/ganban/update.log`; the button's live log reads both. A second update is
refused while one runs. A run that crashed shows as failed, and the next run clears it.

The button is greyed out until `com.ganban.updater` is installed: run `ops/install.sh` on the host once. When an
update never starts (the card says "the update didn't start"), the card shows launchd's last exit code for the job
and the end of `updater.out.log`. `ops/update.sh` writes its status before anything else, so the usual causes show
there: no `install.env`, or `node` missing from the job's `PATH`. Run `ops/install.sh` again on the host, and check
that the host's checkout pulls from the right remote (`git remote -v`).

### Client builds

Once the new server is healthy, `ops/update.sh` builds the client apps from the same commit
(`ops/build-clients.sh`), and the apps update themselves from your host:

- **The desktop app** for this Mac, signed with the updater key. Desktop apps check the host at launch, every 6 hours
  and from Settings → Updates, download in the background, and offer "Restart to update". `GANBAN_CLIENT_FULL=1` adds
  the engine bundle.
- **The Android APK** (arm64), signed with your release keystore. The phone offers "Update available", then Android's
  install prompt.

Each build's version is `<major>.<minor>.<commit count>` from `src-tauri/tauri.conf.json` (today `1.0.<count>`) (Android's version code is `500000 + count`), so every commit is newer.
The builds land in `~/Library/Application Support/com.scs.gansty/client-builds/` (`desktop/darwin-aarch64/`,
`android/`, each with a `manifest.json`), and the host serves them at `/updates/…` to paired devices only. They add
10–20 minutes to an update, after the server is back up. `GANBAN_CLIENT_BUILDS` in `install.env` picks which:
`desktop,android` (the default), one of them, or `none`. Set it with `ops/install.sh --client-builds none` (or
`desktop`, `android`, `desktop,android`); a reinstall keeps it. Run `ops/build-clients.sh` alone to rebuild just the
clients.

**Devices on GitHub Releases don't need host builds.** An app downloaded from GitHub Releases updates from GitHub
(ADR 0008), never from the host. If all your devices run those, set `--client-builds none`: the update then only
updates the server, and Settings → Updates says "This host doesn't build apps; devices update from GitHub releases".

**Once, on the host:**

1. `ops/install.sh --client-keys` makes the updater's key pair in `…/com.scs.gansty/keys/` (`updater.key`,
   `updater.key.pub` and a random password in `updater.pass`, mode 600). It never overwrites them: a new key means
   installing every desktop app by hand once.
2. The Android keystore: put your release keystore and a `keystore.properties` beside it in the same folder
   (`keyAlias=`, `password=` for both the store and the key, `storeFile=` absolute or relative to `keys/`), mode 600.
   `--client-keys` checks it with `keytool`. When there's none, it offers to make one (`--new-keystore` makes it
   without asking).
3. Back up the `keys/` folder. Losing the updater key means reinstalling the desktop apps by hand. Losing the keystore
   means reinstalling the phone app and pairing it again.
4. Run `ops/install.sh` again (it installs `com.ganban.updater`), then `ops/update.sh`.

**Once, on each device:** install the first host-built app by hand, because apps built elsewhere don't know your
updater key. On a Mac, take the `.app.tar.gz` from `client-builds/desktop/…/`, unpack it and replace
`/Applications/Ganban.app`. On the phone, install the APK from `client-builds/android/` (or from the host's
`/download` page). **A phone whose Ganban was signed with another key** refuses the update: uninstall Ganban first,
once. That deletes its local data, so pair it again afterwards (§4.3).

**Reading failures.** A client build never fails the update and never rolls back the server. Each client gets a line
at the end, and the previous build stays published.

- `desktop: built 1.0.990`: published.
- `…: skipped: <why>`: a missing key, keystore, SDK, NDK, Java or tool, or `GANBAN_CLIENT_BUILDS`. The reason names
  what to add.
- `…: failed: <why>`: the build broke; the reason is its last error line. The whole build output is in
  `~/Library/Logs/ganban/update.log`. The Android build finds its toolchain through `ANDROID_HOME`, `NDK_HOME` and
  `JAVA_HOME`, which `ops/install.sh` copies from your shell into the updater's job. Run `ops/install.sh` again after
  installing or moving them.

### Without the service

On Linux, or a host running the desktop app or `serve:headless`, update by hand:

```bash
cd $REPO && git pull
npm ci                                   # when package.json changed
npm run build                            # the web UI: dist/ isn't in git, so git pull never changes it
cargo build --release -p ganban-server   # the server: when crates/ changed
ops/backup.sh                            # Linux: GANBAN_APP_DIR=~/.local/share/com.scs.gansty ops/backup.sh
systemctl --user restart ganban          # Linux with the unit from §1.5
```

Client builds and the Update the server button need the macOS service.

### Which build is a device running?

Every screen shows it: desktop Settings (bottom of the left list), touch More → Settings (bottom), and the Join
screen's footer: `build <git-hash> · <date>`. A `+` after the hash means the build had uncommitted changes. The host
publishes the same stamp at `/build.json`. If a phone's stamp isn't the commit you just deployed, the phone is stale.

Stale web clients fix themselves: they compare their stamp with `/build.json` at start and when they come back after
10 minutes or more, and show **"A newer Ganban is on the host · Reload"**. If an iPhone Home Screen app still shows an
old stamp, swipe it away in the app switcher and reopen it; failing that, remove it and add it to the Home Screen again
(it will need pairing again, §4.3).

---

## Part 7: Backups and restore

`ops/backup.sh` takes sqlite3's online backup (safe while the server writes), checks the copy, compresses it and keeps
the newest 14 in `<app dir>/backups/` (`--keep N` changes that). The macOS service runs it at 03:30 every night and
before every update; on Linux, use the cron line from §1.5. Run it by hand at any time.

`<app dir>` is `~/Library/Application Support/com.scs.gansty` on macOS and `~/.local/share/com.scs.gansty` on Linux.
Uploaded files live in `<app dir>/shared/`; back that folder up too, with your usual backup tool.

**To restore a backup:**

1. Stop the server: `launchctl bootout gui/$(id -u)/com.ganban.server` on macOS, `systemctl --user stop ganban` on
   Linux.
2. Move `gansty.db`, `gansty.db-wal` and `gansty.db-shm` out of `<app dir>`.
3. Unpack the backup in their place:
   `gunzip -c "<app dir>/backups/gansty-<time>.db.gz" > "<app dir>/gansty.db"`.
4. Start the server again: `ops/install.sh` on macOS, `systemctl --user start ganban` on Linux.

---

## Knowledge base (ragrat): coming later

ragrat is the knowledge-base engine behind Atlas and the AI overview. It indexes each project's tasks, notes and files
so the assistant can ground its answers. It isn't published yet.

**Ganban works fully without it.** Chat, tasks, files, sharing, pairing and updates don't need it; Atlas and the AI
overview say "not set up". Leave **Settings → AI Engines → ragrat** empty. When ragrat is available it will run on the
host's loopback at `127.0.0.1:8780`, and you'll point that card at it. Its variables are in
[ENV_REFERENCE.md](ENV_REFERENCE.md#knowledge-base-ragrat-coming-later).

---

## Troubleshooting

- **A phone doesn't show something it should.** Check its build stamp (Part 6). Usually the host serves an old `dist/`
  (`npm run build` wasn't run after `git pull`), or the phone cached the previous one; the banner or a relaunch fixes
  that.
- **"Connected" but chat fails.** The chosen chat model isn't pulled. `ollama pull <model>` must match the model in
  Settings → Models. With none chosen, Ganban asks for `llama3.1:8b`.
- **Chat errors in the Assistant.** Ollama isn't running. Run the health checks in Part 5.
- **Settings don't reach the host.** You saved them on a desktop in **local** mode, which writes to that machine's
  database. Save them on the host itself, or connect the desktop in **online** mode first (Part 3).
- **The server stops at start with a `GANBAN_ADDR` error.** It must be `IP:PORT`, e.g. `0.0.0.0:8765`.
- **`ops/install.sh` refuses: something holds the port or the database.** Usually the desktop app on the host. Quit it
  and run the script again.
- **No Tailscale address in Sync → Host this device.** Run `tailscale up` and check that `tailscale ip -4` returns a
  `100.x` address before starting the server.
- **An invite says "This link can't reach anyone off your tailnet", with "Tailscale rejected the credential (401)".**
  The Tailscale API access token behind auto-share has expired; Tailscale caps them at 90 days. Make a new one
  (Tailscale admin console → Settings → Keys → Generate access token) and paste it in Settings → Sync → Tailscale →
  Check. Or skip the token: share the machine yourself (admin console → Machines → the host → ⋯ → Share… → Generate
  invite link) and attach that link in the invite. Either way the other person accepts *one machine* onto their own
  tailnet; they never join yours.
- **A pairing link has expired.** They're single-use and last about 24 hours. Make a new one (Sync on the host, or
  `scripts/pair-link.sh`).
- **The phone shows "Can't reach your host" (Retry).** The pairing is fine. The host is asleep or offline, or the phone
  is off the tailnet. Wake the host or turn on Tailscale, then Retry.
- **An iPhone Home Screen app opens on the Join screen while the Safari tab works.** It's a separate device with no
  token yet. Pair it (§4.3).
- **Someone lost every signed-in device.** The owner: Contacts → the person → **Pair a new device**. Don't re-invite
  them or make a new contact; that would be a second identity.
- **Never Funnel the main port.** Funnelling `8765` puts the whole server on the public internet, outside the tailnet
  the security model relies on. Use `tailscale serve` for HTTPS, and Funnel only the share door.
