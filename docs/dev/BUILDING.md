# Building Ganban

How to build Ganban from source: the desktop app, the headless server, the phone apps and release builds. To run the
tests, see [TESTING.md](TESTING.md). To run a server for real use, see
[SELF_HOSTING.md](../host/SELF_HOSTING.md).

## What you're building

One Rust workspace and one web UI:

| Part | Where | Builds into |
|---|---|---|
| The web UI (React, TypeScript, Vite) | `src/` | `dist/` |
| `ganban-core`: the data model, migrations and business logic | `crates/core` | a library |
| `ganban-server`: the HTTP server (axum) | `crates/server` | the library the desktop app embeds, and the standalone `ganban-server` binary |
| `gansty`: the desktop and phone shell (Tauri 2) | `src-tauri` | the desktop app, the Android APK, the iOS app |
| The Android self-update plugin | `crates/tauri-plugin-apk-updater` | part of the Android app |

[Architecture.md](../design/Architecture.md) has the full picture.

## Prerequisites

**For everything:**

- **Node.js** 20.19 or later (or 22.12 or later), with npm ([nodejs.org](https://nodejs.org/)).
- **Rust**, the latest stable, through [rustup](https://rustup.rs/).

**For the desktop app**, your platform's Tauri dependencies
([Tauri's list](https://v2.tauri.app/start/prerequisites/) has the details):

- **macOS:** the Xcode Command Line Tools: `xcode-select --install`.
- **Debian or Ubuntu:**
  ```bash
  sudo apt update
  sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file libssl-dev \
    libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev
  ```
- **Fedora:**
  ```bash
  sudo dnf install webkit2gtk4.1-devel openssl-devel gtk3-devel libappindicator-gtk3-devel librsvg2-devel
  ```
- **Windows:** the Microsoft Visual C++ Build Tools, and WebView2 (already on Windows 10 and 11).

**For the server alone** on Linux, `pkg-config` and `libssl-dev` (or `openssl-devel`) are enough; the Email tab
links OpenSSL.

**Optional:** [Ollama](https://ollama.com) for the AI assistant. Ganban builds and runs without it. The document
engine, ragrat, isn't public yet and nothing here needs it.

## Get the code and its dependencies

```bash
git clone https://github.com/PeterK0/Ganban.git
cd Ganban
npm ci
```

`npm ci` installs exactly what `package-lock.json` lists. Cargo fetches the Rust crates on the first build.

## The desktop app, in development

```bash
npm run tauri dev
```

This starts Vite with hot reload, builds the Rust shell and opens the app. The first build takes a few minutes.

**It opens your real data.** The development app uses the same data folder as an installed Ganban (on macOS,
`~/Library/Application Support/com.scs.gansty/`). If you use Ganban day to day, quit it and back up that folder
first, or develop in the browser against a throwaway host instead (next section).

## The server

The standalone server serves the web UI and the same API the desktop app uses in-process:

```bash
npx vite build                    # the web UI, into dist/
cargo build -p ganban-server      # the server, into target/debug/ganban-server
```

**For development**, run it on a throwaway database with sample data:

```bash
scripts/qa-host.sh 8823           # builds what's missing, seeds, and serves http://127.0.0.1:8823/
```

See [TESTING.md § QA host](TESTING.md#qa-host). This is the quickest loop for UI work: rebuild `dist/` with
`npx vite build` and reload the page. Restart the host after a Rust change (`scripts/qa-host.sh 8823 --build`).

**For real use**, build it in release mode. `--features embed-web` bakes `dist/` into the binary, so it runs from any
folder:

```bash
npm run build
cargo build --release -p ganban-server --features embed-web
```

Running it as a service, its addresses and pairing devices are in [SELF_HOSTING.md](../host/SELF_HOSTING.md). Its
environment variables are in [ENV_REFERENCE.md](../host/ENV_REFERENCE.md).

**Leaving tabs out.** Each tab is a cargo feature of `ganban-server` (`tab-pdf`, `tab-email`, …), all on by default.
`--no-default-features --features tab-nato,tab-kanban` builds a server with just those two. See
[TAB_SPEC.md](TAB_SPEC.md).

## Release builds

| What | Command | Lands in |
|---|---|---|
| The desktop app for this machine | `npm run build:desktop` | `target/release/bundle/`, in the formats Tauri makes for your OS (a `.dmg` and `.app` on macOS) |
| The server, with the web UI inside | `cargo build --release -p ganban-server --features embed-web` (after `npm run build`) | `target/release/ganban-server` |
| Android (APK) | `npm run build:android` | under `src-tauri/gen/android/`; Tauri prints the path |
| iOS | `npm run build:ios` | Xcode's output; needs an Apple developer account for signing |

- Each platform builds for itself: build the macOS app on a Mac, the Windows app on Windows.
- `npm run build:release` and `npm run build:desktop:full` bundle the ragrat engine into the app. They need a ragrat
  checkout, which isn't public yet. [BUNDLING.md](../host/BUNDLING.md) covers them and code signing.
- Tagged releases are built by GitHub Actions (`.github/workflows/release.yml`). See
  [§ GitHub releases and their updates](#github-releases-and-their-updates).

**Android** needs the Android SDK and NDK, and Java 17. Android Studio installs all three. Set `ANDROID_HOME`,
`NDK_HOME` and `JAVA_HOME`, and add the Rust targets once:

```bash
rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android
```

A release APK is signed when `src-tauri/gen/android/keystore.properties` exists; without it, Gradle builds an
unsigned one. A host can build and serve the phone app to its own devices: see
[SELF_HOSTING.md § Client builds](../host/SELF_HOSTING.md#client-builds).

## GitHub releases and their updates

Pushing a tag `v<version>` (it must match `package.json`) builds every platform into a draft release, then publishes
it with a `latest.json`. The apps it builds are on the `github` update channel: they update themselves from the
repo's latest release ([UPDATES.md § GitHub Releases](../design/UPDATES.md#github-releases-the-github-channel),
ADR 0008). A fork builds apps that update from the fork.

To sign your own updates, a fork needs its own key pair and two repo secrets (Settings → Secrets and variables →
Actions):

```bash
npx tauri signer generate -w ~/.tauri/ganban-github.key   # asks for a password
cp ~/.tauri/ganban-github.key.pub src-tauri/updater/github.pub   # commit this
```

| Secret | Value |
|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | the content of `~/.tauri/ganban-github.key` |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | its password |

Without them the release still builds, but the desktop apps can't update themselves. Keep the key: an app only
installs updates signed by the key it was built with. For phone updates, also set the `ANDROID_KEY_*` secrets (the
workflow's header lists them) and keep the same keystore for every release.

## Version numbers

`package.json`, the Cargo crates and `src-tauri/tauri.conf.json` carry the release version, which GitHub releases use
as is (the APK's version code is `major·1000000 + minor·1000 + patch`). Client builds a host makes for its own
devices take `<major>.<minor>.<commit count>`, so every commit is newer than the last.
