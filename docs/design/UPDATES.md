# Client updates: the brief

ADR 0007 has the decision for host-built apps; ADR 0008 adds apps from GitHub Releases
([§ GitHub Releases](#github-releases-the-github-channel)). The choices (2026-11-02):
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
- Android's version code must only grow, so it is set explicitly: `bundle.android.versionCode = 500000 + count`. It
  ignores the major and minor, and the count only goes up.
- The client reads its own version with `getVersion()`.

### On the host

- **Builds** live in `<APP_DIR>/client-builds/`:
  - `desktop/<target>-<arch>/`: the `.app.tar.gz`, its `.sig` and a `manifest.json`;
  - `android/`: the APK and a `manifest.json`.
- **`get_client_builds`** (any member) returns:
  ```
  { desktop: { version, target, arch, pubDate, size } | null,
    android: { version, versionCode, pubDate, size, sha256 } | null }
  ```
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
- **The public key** goes in at build time from the key file (the host's build script passes it as a `--config`
  override), so no key sits in git. A build without a key has no updater, and says so in Settings.
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

A keyed build without a channel counts as `host` (host builds from before channels). A `github` build without a valid
`owner/name` repo can't update. The pure parts are `src/lib/update.pure.ts` (the channel, the URLs) and
`src/lib/apkUpdate.pure.ts` (the release's APK, the semver compare); `src/lib/updateChannel.ts` holds the switch.

### The release workflow

- `prepare` checks that `package.json`, `tauri.conf.json` and the tag agree (`v1.0.2` builds `1.0.2`), and makes one
  draft release for the tag.
- The desktop builds merge `bundle.createUpdaterArtifacts: true` and the GitHub public key into the config
  (`--config target/github-updater.conf.json`, written from `github.pub`) and sign with the
  `TAURI_SIGNING_PRIVATE_KEY` secret. tauri-action uploads the installers and the signed updater bundles: the
  `.app.tar.gz` per Mac, the `.msi` and `-setup.exe`, the `.AppImage` (and `.deb`), each with its `.sig`. Without the
  secret, the build has no updater and warns.
- The Android build sets `versionCode = major·1000000 + minor·1000 + patch` (Tauri's formula, explicit) and uploads
  `Ganban_<version>_universal.apk`.
- `publish`, after all of them, writes `latest.json` with `scripts/updater-json.mjs` from the draft's assets and
  `.sig` files, refuses when one of `darwin-aarch64`, `darwin-x86_64`, `linux-x86_64` or `windows-x86_64` is missing,
  uploads it and publishes the release as `latest`. Each bundle gets `<os>-<arch>-<installer>`, so an NSIS install
  updates with the NSIS installer and an MSI install with the MSI. The plain `<os>-<arch>` key is the `.app`, the
  MSI (tauri-action's `updaterJsonPreferNsis` default) or the AppImage.

### The desktop app

`update_check` ignores the host and token on the `github` channel and asks
`https://github.com/<repo>/releases/latest/download/latest.json`. Insecure transport stays off (GitHub is https).
The 6-hourly check, the background download and **Update ready · Restart** are unchanged. Settings → Updates shows
"Updates from GitHub Releases · <repo>" instead of the host's build, and the switch.

### The phone (Android)

The app asks `https://api.github.com/repos/<repo>/releases/latest` (no auth) and compares the tag with its version
name by semver. It takes the release's first `.apk` asset without "unsigned" in its name, and downloads it through
the apk-updater plugin with no token, following GitHub's redirect. It checks the sha256 against the asset's
`digest` (`sha256:…`) when GitHub gives one, and skips the check otherwise: Android refuses an APK signed with
another key anyway. The install prompt and the states are the host channel's.

### The switch

**Check GitHub for new versions** in Settings → Updates (desktop) and Settings → App update (Android) shows only on
`github` builds. It's on by default and stored per device (`ganban.updates.github` in `localStorage`, beside the
host address). Off, the app sends GitHub nothing: no check at launch, on resume or on the timer.
