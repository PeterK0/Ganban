# Apps downloaded from GitHub Releases update from GitHub Releases

ADR 0007 has host-built apps update from their own host. Most people download Ganban from the repo's GitHub
Releases and never run a host that builds apps, so their apps couldn't update at all. Each build now carries an
**update channel**, fixed when it's built: `host` (made by `ops/build-clients.sh`), `github` (made by
`.github/workflows/release.yml`), or none (a dev build, which doesn't update). A `github` build asks its own repo's
latest release: the desktop app reads `latest.json` through Tauri's updater, and the Android app reads GitHub's
latest-release API, compares the tag with its version by semver and downloads the `.apk`. The download, the "Update
ready · Restart" notice and Android's install prompt are the ones host builds use.

Each channel has its own signing key. A `github` build carries only the GitHub key's public half
(`src-tauri/updater/github.pub`), and a `host` build only its host's, so a bundle signed for one channel never
installs on the other. The repo comes from the workflow (`github.repository`), so a fork's apps update from the
fork's releases, signed with the fork's key.

## Considered options

- **Ask before the first check (opt-in):** rejected. People who download from GitHub already trust it, and an app
  that silently stays on its first version stays on its bugs. Checking is on by default, and Settings → Updates
  turns it off with **Check GitHub for new versions**.
- **One key for both channels:** rejected. A host's key lives on that host; GitHub's lives in the repo's secrets.
  Sharing one would let either sign for both.
- **tauri-action's own `latest.json`:** rejected. Each parallel build reads, merges and rewrites it, so two builds
  finishing together can drop a platform. One job writes it after every build has uploaded.

## Consequences

- A `github` build contacts github.com: at launch, every 6 hours and from Settings, with no token or account. GitHub
  sees the device's IP address and the app's user agent. With the switch off it sends nothing.
- A release is a draft until every desktop build and the APK are up, then `latest.json` is written and the release
  published. A failed build leaves the draft unpublished, so no app is offered a half-built release.
- The repo needs the `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` secrets. Without them the
  apps still build, but can't update themselves. Losing the key means everyone installs the next version by hand
  once.
- The phone app needs every release's APK signed with the same keystore (the `ANDROID_*` secrets); Android refuses
  an update signed with another key.
- Apps from before this change (1.0.1 and older) carry no updater: they move onto GitHub updates with one last
  manual install.
