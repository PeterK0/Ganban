# Each device chooses where its app updates from

ADR 0007 has host-built apps update from their host, and ADR 0008 has GitHub builds update from GitHub Releases, each
fixed when the app is built. A maintainer whose host builds every commit (a staging host) wants to test those builds
on the devices he installed from GitHub, and go back to GitHub once a release is out. So the **update source** is now
a per-device setting, **Updates from** in Settings → Updates: **GitHub Releases** or **This server**, on the desktop
and on Android. The build's update channel only sets the default. The choice stays on the device.

Each source keeps its own trust:

- **Desktop.** Every build carries the project's updater public key (`src-tauri/updater/github.pub`), so any build can
  update from GitHub Releases. For This server the app checks against the key the host advertises
  (`get_client_builds`): it pins that key the first time, shows its id, and asks before it trusts a different one. A
  host build trusts the key it was built with until then. Tauri's updater takes the key and the endpoint per check.
- **Android.** An APK installs only over an app signed with the same certificate. The host publishes its APK's
  certificate SHA-256, and builds know GitHub Releases' certificate (public). The app compares a source's certificate
  with its own signature and offers the source only when they match. Otherwise it explains that switching needs a
  one-time reinstall.

A host signed with the project's keys (the same updater key and keystore as the release workflow) lets its devices
switch freely. A host with its own keys still works: its builds update from it, and switching to GitHub needs a
reinstall on Android.

## Versions across sources

A host build's version is `1.0.<commit count>` and a release's is `1.0.<n>`, so they don't compare. The desktop on
the other channel's source accepts **any different version** (so it can go back to an older release). On its own
source only a newer one counts. Android can't install a smaller version code, so the codes share one order:
releases from 1.0.10 on are `(major·1000000 + minor·1000 + patch)·1000`, and a host build is the release it follows
(`tauri.conf.json`'s version) times 1000 plus the commits since, at most 999. A host build after 1.0.9 sorts between
1.0.9 (`1000009`, the old code) and 1.0.10 (`1000010000`). Android's ceiling of 2,100,000,000 caps this scheme below
major version 3.

## Considered options

- **Keep the channel fixed and reinstall to move:** rejected. The maintainer tests every staging build on his
  devices, and each move would be a reinstall (and, on Android, a re-pair).
- **Trust the host's key without pinning:** rejected. Anyone who could answer as the host could then push an app.
  Pinning on first use, with the id shown and a prompt on change, keeps that to the first switch.
- **Allow any different version on Android too:** impossible. Android refuses a smaller version code, so the codes
  had to share an order.

## Consequences

- The host's update builds the version code from `ops/version-code.mjs`. Phones on host builds from before this change
  (`500000 + count`) upgrade to the new codes as usual.
- A phone on a host build can't go back to an older GitHub release. It waits for the next release, which installs
  over it.
- A host build knows its GitHub repo (`GANBAN_GITHUB_REPO`, default the project's) and GitHub's APK certificate
  (`src-tauri/updater/github-android-cert.txt`, or `VITE_GITHUB_ANDROID_CERT`). Without the certificate, its phones
  don't offer GitHub Releases, and say why.
- A device on This server never contacts GitHub, as before, and the "Check GitHub for new versions" switch still
  silences GitHub when the source is GitHub.
