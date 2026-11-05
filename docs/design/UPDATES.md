# Client updates: the brief

ADR 0007 has the decision for host-built apps; ADR 0008 adds apps from GitHub Releases
([§ GitHub Releases](#github-releases-the-github-channel)); ADR 0011 lets each device choose between the two
([§ The update source](#the-update-source-github-releases-or-this-server)). The choices (2026-11-02):
- the host (a Mac) builds the clients during each host update, with the Android toolchain and Xcode tools installed;
- an "Update the server" button for the owner;
- the phone downloads in the app, then Android's install prompt;
- the desktop downloads in the background, then "Restart to update".

## The interface (fixed, so the three lanes can run in parallel)

### Versions

- A client build's version is `<major>.<minor>` from `src-tauri/tauri.conf.json` plus the commit count
  (`1.0.<git rev-list --count HEAD>`), set at build time (Tauri's `--config` override, not a commit). Builds before
  1.0 were `0.5.<count>`, so every 1.0 build is newer to the desktop updater. Bump the minor or major in
  `tauri.conf.json` and the next build carries it.
- Android's version code must only grow, and it must sort host builds and releases in one order, so a phone can
  move between them (ADR 0011). `ops/version-code.mjs` sets it explicitly:
  - a release from 1.0.10 on: `(major·1000000 + minor·1000 + patch)·1000` (1.0.10 is `1000010000`); releases before
    had Tauri's formula, without the `·1000` (1.0.9 is `1000009`);
  - a host build: the release it follows (`tauri.conf.json`'s version) `·1000`, plus the commits since that version
    changed, at most 999. So a host build after 1.0.9 is `1000009001`…`1000009999`, between 1.0.9 and 1.0.10.
  - Android's ceiling (2,100,000,000) caps this scheme below major version 3: `ops/version-code.mjs` refuses 3.0.0.
  - Host builds from before this scheme were `500000 + count`; the new codes are larger, so they upgrade as usual.
- The client reads its own version with `getVersion()`.

### On the host

- **Builds** live in `<APP_DIR>/client-builds/`:
  - `desktop/<target>-<arch>/`: the `.app.tar.gz`, its `.sig` and a `manifest.json`;
  - `android/`: the APK and a `manifest.json`.
- **`get_client_builds`** (any member) returns:
  ```
  { desktop: { version, target, arch, pubDate, size, pubkey } | null,
    android: { version, versionCode, pubDate, size, sha256, certSha256 } | null }
  ```
  `pubkey` is the updater public key the desktop build is signed for (its manifest's, else
  `<APP_DIR>/keys/updater.key.pub`); `certSha256` is the APK's signing certificate, 64 lowercase hex digits. Either
  is `null` when the host doesn't know it. They make the host an update source a device can choose (§ The update
  source). Paired devices only: it's a command in the command table, behind the device token.
- **`GET /updates/desktop/:target/:arch/:current_version`** answers the Tauri updater:
  - with `200 {version, notes, pub_date, url, signature}` when the build is newer, otherwise `204`;
  - `url` is absolute, pointing at `/updates/desktop/:target/:arch/bundle` on the same host.
- **`GET /updates/desktop/:target/:arch/bundle`** and **`GET /updates/android/apk`** stream from disk with Range.
- **Auth:** all three routes accept a device token in `Authorization: Bearer`, or `?token=` (as the existing
  download routes do). Loopback is the owner.
- **`start_host_update`** (owner only) starts `ops/update.sh` as its own launchd job (`com.ganban.updater`, installed
  by `ops/install.sh`), so the server's restart doesn't kill it. It refuses while one is running.
- **`get_host_update_status`** (owner only) returns:
  ```
  { state: "idle" | "running" | "succeeded" | "failed", step, startedAt, finishedAt, fromBuild, toBuild,
    clients: { desktop: string, android: string },  // "built 1.0.975" | "skipped: <why>" | "failed: <why>"
    log: string /* the last 200 lines */ }
  ```
  `ops/update.sh` writes it as it goes, to `<APP_DIR>/update-status.json` plus `<LOGS>/update.log`, so it survives
  the restart.

### `ops/update.sh`

After the server's health check passes, it builds the clients: the desktop app with updater artifacts, signed with
the updater key, and the Android APK with the release keystore.
- A missing tool or key skips that client and says why. A failed client build is reported, never rolled back over.
- It keeps the previous client build if the new one fails.
- `GANBAN_CLIENT_BUILDS=desktop,android` in `install.env` chooses which, defaulting to both. `none` turns them off.

### The desktop app

- **`tauri-plugin-updater`**, driven from Rust with runtime endpoints: the connected host's
  `/updates/desktop/{{target}}/{{arch}}/{{current_version}}` with the device token header, and insecure transport
  allowed (the tailnet is http; the signature guards integrity).
- **The public keys:** the host's goes in at build time from the key file (the host's build script passes it as a
  `--config` override). Every build also carries the project's (`src-tauri/updater/github.pub`, compiled in), for
  GitHub Releases. The check picks the key per source (§ The update source). A dev build (no channel, no key) has no
  updater, and says so in Settings.
- **When it checks:** at launch, every 6 hours, and when Settings → Updates opens. It downloads in the background,
  then a quiet notice in the top bar says "Update ready: Restart". Settings → Updates shows the version, the host's
  build and the state.
- **Settings → Updates** also gets the owner's **Update the server** button: a confirm, then a live log (polling
  `get_host_update_status` every 2 s), the step, the result, and each client's line. It survives the host's
  restart: it keeps polling through connection errors for up to 3 minutes. The status also says which clients the
  host builds (`clientBuilds`, from `install.env`; with `none` the card hides the app lines), whether the updater
  job is installed (`updaterInstalled`; the button is disabled without it), and, for a run that stopped without
  finishing, launchd's last exit code and the tail of the job's own log (`launchd`).
- The old Tier-1 check (`src/lib/update.ts`, the "update available" link) is replaced on desktop. The first-install
  download page (`/download`) stays.

### The phone (Android)

- **A small native part** (a Tauri mobile plugin in Kotlin) downloads the APK from the host with the device token,
  checks its sha256, and starts the install intent through a `FileProvider`. It needs the
  `REQUEST_INSTALL_PACKAGES` permission. When the device doesn't allow installs from Ganban yet, it opens that
  settings page and explains.
- **The app** compares its version code with `get_client_builds().android.versionCode` at launch, on resume and from
  Settings. It shows "Update available (1.0.975)" with Update, a progress bar, then Android's prompt.

## GitHub Releases: the `github` channel

ADR 0008 has the decision. Every build has an **update channel**, fixed at build time by `VITE_UPDATE_CHANNEL`
(read by the frontend through `import.meta.env` and by `src-tauri` through `option_env!`):

| Channel | Built by | Updates from | Key |
|---|---|---|---|
| `host` | `ops/build-clients.sh` | the connected host, with the device token | the host's, `<APP_DIR>/keys/updater.key.pub` |
| `github` | `.github/workflows/release.yml`, with `VITE_UPDATE_REPO=<github.repository>` | that repo's latest release, no token | `src-tauri/updater/github.pub` |
| none | `npm run tauri dev`, a hand-made build | nothing | none |

The channel sets the default **update source**; the device can switch (§ The update source). A keyed build without a
channel counts as `host` (host builds from before channels). Host builds also get `VITE_UPDATE_REPO` (from
`GANBAN_GITHUB_REPO`, default `PeterK0/Ganban`), so they can switch to GitHub Releases. A `github` build without a valid
`owner/name` repo can't update from GitHub. The pure parts are `src/lib/update.pure.ts` (the channel, the URLs) and
`src/lib/apkUpdate.pure.ts` (the release's APK); `src/lib/updateChannel.ts` holds the switch and the source.

### The release workflow

- `prepare` checks that `package.json`, `tauri.conf.json` and the tag agree (`v1.0.2` builds `1.0.2`), and makes one
  draft release for the tag.
- The desktop builds merge `bundle.createUpdaterArtifacts: true` and the GitHub public key into the config
  (`--config target/github-updater.conf.json`, written from `github.pub`) and sign with the
  `TAURI_SIGNING_PRIVATE_KEY` secret. tauri-action uploads the installers and the signed updater bundles: the
  `.app.tar.gz` per Mac, the `.msi` and `-setup.exe`, the `.AppImage` (and `.deb`), each with its `.sig`. Without the
  secret, the build has no updater and warns.
- The Android build sets the version code from `ops/version-code.mjs release <version>` (§ Versions), builds with
  `VITE_GITHUB_ANDROID_CERT` (the keystore certificate's SHA-256, from `keytool`) and uploads
  `Ganban_<version>_universal.apk`.
- `publish`, after all of them, writes `latest.json` with `scripts/updater-json.mjs` from the draft's assets and
  `.sig` files, refuses when one of `darwin-aarch64`, `linux-x86_64` or `windows-x86_64` is missing (Intel Macs aren't built since 1.0.7),
  uploads it and publishes the release as `latest`. Each bundle gets `<os>-<arch>-<installer>`, so an NSIS install
  updates with the NSIS installer and an MSI install with the MSI. The plain `<os>-<arch>` key is the `.app`, the
  MSI (tauri-action's `updaterJsonPreferNsis` default) or the AppImage.

### The desktop app

On GitHub Releases, `update_check` ignores the host and token and asks
`https://github.com/<repo>/releases/latest/download/latest.json`, with the project key. The 6-hourly check, the
background download and **Update ready · Restart** are unchanged.

### The phone (Android)

The app asks `https://api.github.com/repos/<repo>/releases/latest` (no auth) and compares the tag's version code
(§ Versions) with its own. It takes the release's first `.apk` asset without "unsigned" in its name, and downloads it through
the apk-updater plugin with no token, following GitHub's redirect. It checks the sha256 against the asset's
`digest` (`sha256:…`) when GitHub gives one, and skips the check otherwise: Android refuses an APK signed with
another key anyway. The install prompt and the states are the host channel's.

### The switch

**Check GitHub for new versions** in Settings → Updates (desktop) and Settings → App update (Android) shows while the
device's source is GitHub Releases. It's on by default and stored per device (`ganban.updates.github` in
`localStorage`, beside the host address). Off, the app sends GitHub nothing: no check at launch, on resume or on the
timer.

## The update source: GitHub Releases or This server

ADR 0011 has the decision. **Updates from** in Settings → Updates (desktop) and Settings → App update (Android) is a
dropdown: **GitHub Releases** (`owner/name`) and **This server** (the paired host). Under it, each source's latest
version when known, the server key's id (desktop), and the reason when a source can't be chosen; such a source's
option is disabled. Switching checks that source at once and offers its update: the desktop downloads it and shows
**Restart to update**; the phone shows **Update**, then Android's prompt. The browser shows no dropdown: it doesn't
update itself.

- **Stored on the device:** `ganban.updates.source` (`github` or `host`) in `localStorage`. Unset, it's the build's
  channel. A dev build has no source.
- **Privacy:** a device asks GitHub only while its source is GitHub Releases and the switch is on, the source lines
  included. On This server, the GitHub line says it's asked once chosen.
- **The pure parts** are `src/lib/updateSource.pure.ts` (the choice, the pin, the certificate match, the version
  codes), tested by `npm run test:updatesource`; the store is `src/lib/updateChannel.ts`.

### The desktop

`update_check { source, baseUrl, token, hostKey }` builds Tauri's updater per check
(`updater_builder().pubkey(…).endpoints(…)`, `src-tauri/src/app_update.rs`):

| Source | Endpoint | Key | Token |
|---|---|---|---|
| GitHub Releases | the repo's `latest.json` | the project's (`github.pub`), in every build | never |
| This server | the host's `/updates/desktop/…` | the device's pin, else a host build's own key | the device's |

- **The pin:** the app reads the host's `pubkey` from `get_client_builds`. With nothing pinned, it pins it
  (`ganban.updates.hostKey`) and shows its id (the minisign key id, `E2AABA5857DB92BF` for the project key). A host
  build counts its own build key as the pin. A different key fails the check with "This server's update key changed",
  and **Trust the new key…** asks, with both ids, before it pins the new one.
- **Across sources** (a host build on GitHub, a GitHub build on This server), any different version counts
  (`version_comparator`), because `1.0.<count>` and a release's number don't compare. On the build's own channel's
  source only a newer version does.
- Plain http is allowed for every check (the tailnet); GitHub's endpoint is a fixed https URL.
- `update_sources` tells Settings the channel, the repo, the project key and a host build's own key.

### The phone

- `apk_version` (the apk-updater plugin) also returns the installed app's signing certificates
  (`certSha256`, from `PackageManager`, the signing history included).
- **This server:** the host's `android.certSha256`. **GitHub Releases:** the certificate compiled in
  (`__GITHUB_ANDROID_CERT__`, from `VITE_GITHUB_ANDROID_CERT` or `src-tauri/updater/github-android-cert.txt`).
- A source is offered only when its certificate is one of the app's. On the build's own channel's source an unknown
  certificate is let through, as before. Otherwise Settings says why: another certificate means a one-time reinstall,
  an unknown one names what's missing.
- Both sources compare **version codes** (§ Versions). A smaller one says the source's build is older and that
  Android can't go back; its next build installs over this one.
