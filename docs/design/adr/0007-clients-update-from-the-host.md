# Clients update from the host, which builds and signs them

The host already serves everything else, so it serves the apps too. Each host update (`ops/update.sh`, or the
owner's "Update host" button in the app) builds, after the server is healthy, the desktop app and the Android APK
from the same commit, signs them, and publishes them on the host. The desktop app updates through Tauri's updater:
it downloads in the background, checks the signature against the public key it was built with, and swaps itself in
when you click "Restart to update". The phone downloads the APK in the app and hands it to Android's installer. A
build's version is `<major>.<minor>.<commit count>`, with major and minor from `src-tauri/tauri.conf.json`
(`1.0.<count>` since 1.0, `0.5.<count>` before), so every commit is newer than the last. Android's version code is
`500000 + count`, so it only grows. A failed client build never rolls back a healthy server: the clients just stay
on the build they have.

## Considered options

- **Build on the laptop and upload:** rejected. The point is never to build by hand again.
- **A vendor update service (GitHub Releases, an app store):** rejected for host-built apps. The host serves
  everything, with no phone-home (`src/lib/update.ts`). Apps downloaded from GitHub Releases update from there
  instead (ADR 0008); a host-built app never asks GitHub.
- **Comparing the host's semver:** rejected. The version never changed (0.5.1), so no client ever saw an update.

## Consequences

- The updater's private key and the Android release keystore live on the host, outside git
  (`docs/host/SELF_HOSTING.md` § Client builds). Losing the updater key means installing the desktop app by hand once;
  losing the keystore means reinstalling the phone app, and re-pairing it.
- A device moves onto host-built updates with one last manual install. A phone whose APK was signed with another
  key must uninstall it first.
- The host can restart itself on the owner's command, so the update runs as its own launchd job, not as a child of
  the server.
- Host updates take longer (the client builds add about 10–20 minutes), but they run after the server is back up.
