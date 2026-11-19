# Updates wait for the user, and show their patch notes

Until 1.0.11 the desktop app downloaded a newer version in the background as soon as a check found it, then showed
"Update ready · Restart" (ADR 0007). The owner, and he assumes every other user, hates updates that happen without
his confirmation. So the rule, on every client: **nothing downloads or installs without the user's say-so.**

- **Checking is allowed.** It reads a version file (the host's `/updates/desktop/…`, GitHub's `latest.json` or
  latest release). The desktop checks at launch, every 6 hours and from Settings → Updates; Android at launch and on
  resume; an open browser tab at load and when it comes back after 10 minutes. "Check GitHub for new versions"
  turns GitHub's checks off.
- **A newer version is an offer.** The desktop shows a quiet "Ganban 1.0.12 is available" in the top bar. It opens a
  dialog with the version's patch notes and three choices: **Download and install**, **Later** (until the next
  launch), **Skip this version** (silent until a newer one; Settings still shows it). Only the first downloads.
  Downloaded and verified, it offers **Restart to finish** or **Later**. Android already waited for **Update** and
  Android's own prompt, and the browser for **Reload**; both now show the patch notes first ("See what changed").
- **The host updates only when its owner presses "Update the server"**, as before. The confirm now shows how far
  behind the host is and the patch notes the update brings (`preview_host_update`: a fetch, never a pull). When it
  can't tell, it says so and the update can still go ahead.

**Patch notes** come from `CHANGELOG.md`, through one parser (`src/lib/patchNotes.pure.ts`): bundled into every
build (they work offline), served as `/patch-notes.json` beside `build.json`, written into the GitHub release's body
and `latest.json` by the release workflow, and into the host's client-build manifests by `ops/build-clients.sh`. A
release whose section is missing or empty fails before it builds. After an update, a quiet "What's new" shows the new
entries once; Settings → Updates → Patch notes keeps the whole history.

## How it's held

- The desktop's driver (`createUpdateFlow` in `src/lib/update.pure.ts`) has two entry points, `check` and
  `download`; only the dialog's "Download and install" calls `download`. `npm run test:update` fails if a check
  alone starts a download, if anything else in `src/` calls `update_download`, or if the webview is granted the
  updater plugin's own commands (`src-tauri/capabilities/default.json`). The Rust side never calls
  `download_and_install`, and the plugin's configuration has no automatic install.
- "New" is by entry, not by version: between two host builds the heading stays "Unreleased". A device remembers the
  entries it has seen (`ganban.patchNotes.seen` in `localStorage`, a cosmetic preference). With no record, it's a
  first install: it records everything and shows nothing.

## Considered options

- **Download in the background, ask only before installing:** rejected. A download the user didn't ask for is
  already the thing he dislikes (bandwidth, a surprise on a metered connection), and it saves little: the bundle is
  verified in seconds.
- **A modal "What's new" after each update:** rejected. It blocks the screen at the moment the user wants to work; a
  notice he can open or dismiss carries the same news.
- **Notes from the commit log:** rejected. Commit subjects are for developers; `CHANGELOG.md` is already written for
  users and kept up to date.

## Consequences

- A user who never answers stays on his version. "Later" asks again at the next launch, so an update isn't forgotten.
- A release needs its `## [version] - date` section in `CHANGELOG.md` before it's tagged.
- Builds before this change still download in the background once: the first update to this version works the old
  way.
