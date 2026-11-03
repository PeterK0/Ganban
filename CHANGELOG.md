# Changelog

All notable changes to Ganban are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Apps that update from their host carry a build number as the patch version (`1.0.<commit count>`; see
[ADR 0007](docs/design/adr/0007-clients-update-from-the-host.md)). The entries below are for the tagged releases.

## [Unreleased]

## [1.0.4] - 2026-11-03

- fix(ops): a stalled update shows only its own part of launchd's log
- docs(glossary): series and occurrence
- feat(calendar): one day of a repeating event at a time, week numbers, a Repeating view
- docs(host): --client-builds, GitHub-channel devices, and a stuck update
- feat(updates): 'Update the server' card; installers under an advanced disclosure
- fix(ops): update.sh writes its status first; install.sh --client-builds
- feat(server): the host update status says why an update didn't start
- feat(events): skipped days and one-off copies on a repeating event

## [1.0.3] - 2026-11-03

- fix(shell): the top bar's clock no longer shifts the bar every second
- fix(release): ad-hoc sign the Mac app; say how to open it on first launch

## [1.0.2] - 2026-11-03

- fix(updates): a GitHub build never falls back to the host, and the switch stops a pending download
- docs(updates): ADR 0008, GitHub downloads update from GitHub Releases
- ci(release): signed updater bundles, latest.json, and publish once every build is up
- feat(updates): an update channel per build; GitHub builds update from GitHub Releases
- ci: the release builds Android and skips iOS; a flaky quiz test pinned to one connection
- ci: the Linux test job passes, and names failing tests on the run page

## [1.0.1] - 2026-11-03

- fix(ai): a calm "not set up" without the knowledge engine, and real Settings names
- feat(ui): line icons on the Atlas, Assistant and Bin sub-tabs and the pin menus
- docs: Node 20.19 or later (Vite 7); SyncView's hint names no machine
- docs(user): the user guide and the FAQ, with screenshots
- docs: a fork-ready AGENTS.md, CONTRIBUTING and a security policy
- docs(dev): BUILDING and TESTING; GILT reads as a public style guide
- docs(dev): rewrite TAB_SPEC to match the code, and add a Hello tab tutorial
- fix(scripts): the QA seed's sample task says 'connection', not 'tailnet'
- docs: client build versions follow 1.0; the desktop crate describes itself
- feat(scripts): a portable QA host (scripts/qa-host.sh <port>)
- ci: run on pushes to main and PRs once; build-clients always explains a bad version
- docs(changelog): a Keep a Changelog file with 1.0.0 and the earlier tags
- ci: check pushes and PRs; move the Intel Mac release off macos-13
- docs(map): list every doc in the tree
- docs(readme): rewrite the README for 1.0
- docs(host): fill reviewer gaps in the env reference and the systemd unit
- docs(design): drop owner voice and private roadmap labels
- docs(host): make self-hosting generic for macOS and Linux

## [1.0.0] - 2026-11-03

The first public release. Ganban is now open source under the AGPL-3.0.

### Added

- **Gilt**, a new look for every screen: deco headings over clean text, gold corners, line icons on tabs instead
  of emoji, a resizable sidebar that folds into an icon rail, a top bar that never overflows and a resizable side
  pane. Every theme is drawn in it, on the desktop, in the browser and on the phone.
- **Share links** ([ADR 0006](docs/design/adr/0006-share-links-go-public-through-a-separate-door.md)): share task
  files, project files or any mix of them with someone who has no account. Links go out through a separate,
  download-only door, so the host itself stays private.
- **Apps update from their host** ([ADR 0007](docs/design/adr/0007-clients-update-from-the-host.md)): each host
  update builds, signs and publishes the desktop app and the Android app. The desktop app updates itself in the
  background and asks you to restart. The phone downloads the new APK and hands it to Android's installer.
  Settings → Updates shows the versions, and the host's owner can start a host update from the app.
- **Files:** one file browser for Project → Files and a task's Files tab, with folders, rename and move. Task
  attachments keep their folder path, and big uploads stream with a progress bar, a queue and cancel. Files stay
  out of the AI overview unless someone includes them.
- **Events:** attach files to an event, mark it as past by hand, copy, paste and duplicate events, select several
  with checkboxes, a vertical agenda, and real repeats.
- **Timer:** one timer shared across windows, with a dropdown of recent tasks.
- **Navigation:** back and forward, "Open in Project → Tasks", and a top bar that blends into the macOS title bar.
- **Tabs:** pin tabs to the top bar.
- **Task visibility** ([ADR 0002](docs/design/adr/0002-task-visibility.md)): choose who can see a task, from areas
  down to single tasks. The host enforces it everywhere: commands, search, files, reactions and the assistant.
- **Home:** "Assigned to you" follows the project filter and filters by status. Updates fold away on Home and on
  Project → Home.
- **Host tools:** `ops/install.sh` and `ops/update.sh` keep a self-hosted Ganban server running and update it
  safely: they check, back up, swap in the new build and roll back if it is unhealthy. See
  [Self-hosting](docs/host/SELF_HOSTING.md).
- A `LICENSE` file (AGPL-3.0), this changelog and continuous integration on GitHub Actions.

### Changed

- **One command table** ([ADR 0001](docs/design/adr/0001-one-command-table.md)): every command the apps send lives in
  one table on the host, with its access rule next to it. The desktop app runs the same table in-process. A command
  without an access rule is denied.
- The host logs every upload: who sent it, where it went and how it ended.
- Faster screens: the clock and the scroll bars update without redrawing the app, and the phone app's layout no
  longer relies on a slow CSS selector.
- Atlas indexing and the AI overview use ragrat, which is optional and coming later. Without it Ganban works
  fully, and those screens say "not set up".
- Versions: the app, the host and the crates are all 1.0.0. Host-built apps are numbered `1.0.<commit count>`, so
  they stay newer than every earlier `0.5.<count>` build.

## [0.6.0] - 2026-06-10

### Added

- Desktop file sync: a local copy of a project's files.
- A Members tab per project, with access, presence and time per member.
- A per-project assistant personality, and a conversations list on Project → Home.
- Select several calendar events and delete them at once.

### Fixed

- Closed several access gaps: owner-only project creation and event and contact changes, members' events scoped to
  their projects, and no leaks of contacts or other users' settings.

## [0.5.0] - 2026-06-08

### Added

- The phone app reaches parity with the desktop: home dashboards, project files, reports, linking tasks and events,
  and area editing.
- A tabbed AI Assistant on the desktop and the phone: chats, indexing and models.

### Fixed

- Android release builds are signed for sideloading.
- Closed authorization gaps in public chats.

## [0.1.1] - 2026-06-08

### Added

- The host finds new app builds in a folder and offers them, each with a QR code you can turn on or off.
- A settings window with a tree of sections, and a default storage quota.

### Fixed

- The GIF picker, the settings window's size and profile card contrast.
- The QR scanner can be cancelled.

## [0.1.0] - 2026-06-08

The first tagged release.

### Added

- Accounts, roles and members, with every request checked on the host.
- Pair a device with an invite link or a QR code, and use Ganban from a browser.
- Shared project files with storage quotas.
- Profiles with avatars and contact cards.
- Images and GIFs in comments and descriptions.
- The host offers the right desktop download for each OS, and shares the Android app with a QR code.

[Unreleased]: https://github.com/PeterK0/Ganban/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/PeterK0/Ganban/compare/v0.6.0...v1.0.0
[0.6.0]: https://github.com/PeterK0/Ganban/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/PeterK0/Ganban/compare/v0.1.1...v0.5.0
[0.1.1]: https://github.com/PeterK0/Ganban/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/PeterK0/Ganban/releases/tag/v0.1.0
