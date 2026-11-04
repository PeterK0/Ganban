# Changelog

All notable changes to Ganban are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Apps that update from their host carry a build number as the patch version (`1.0.<commit count>`; see
[ADR 0007](docs/design/adr/0007-clients-update-from-the-host.md)). The entries below are for the tagged releases.

## [Unreleased]

## [1.0.8] - 2026-11-04

### Fixed

- **Finance: importing a long statement no longer locks up the host.** A big import (years of transactions)
  used to hold the database for its whole run, so the rest of Ganban failed with "database is locked" and the import
  itself timed out. Imports now run in the background in short steps, with a progress bar on the Import screen that
  survives a refresh. An interrupted import is safe to run again.
- **Finance: repeated and overlapping imports never duplicate transactions.** Importing the same year twice, or
  exports whose periods overlap, keeps each transaction once. Genuinely identical transactions on the same day (two
  identical coffees) are both kept. The same statement as CSV or Excel, or with its balance column hidden, is
  recognised as the same.
- The host's database now runs in WAL mode with a longer wait for busy moments, so reads don't wait on writes.

## [1.0.7] - 2026-11-04

### Added

- **Finance:** a personal ledger for your money. It's optional: turn it on in Settings → Plug-ins → Sections, and
  it appears in the sidebar and in the phone's More screen. Only you see it, the host's owner included.
  - Import statements from CSV or Excel. Revolut and Piraeus exports are recognised as they are, and any other bank
    goes through a column-mapping wizard that remembers the layout. Re-importing an overlapping export adds nothing.
  - Transfers between your own accounts and currency exchanges are paired automatically. Refunds count against
    the category of what you bought. Split a transaction across categories. Rules learn from your corrections.
  - Budgets per category, a forecast of the month's end balance with a likely range, recurring and planned items.
  - Double-entry accounting on IFRS principles underneath, with an Accounting view: the journal, manual journals
    in any currency, the trial balance, the chart of accounts, month-end close with currency revaluation (IAS 21),
    and costs spread over months.
  - Four statements (financial position, profit or loss, cash flows, changes in net worth), monthly or yearly with
    comparatives, exportable to PDF and CSV.
  - Exchange rates come from the European Central Bank, cached on the host.
  - A weekly reminder to import your statements (Monday 09:00 by default, adjustable).
  - The full Finance tab on the phone, with a quick way to log a cash expense.
  - Personal chats: the assistant can answer questions about your finances, read-only, in a chat only you see,
    and only on a local model. It can also suggest categories for new transactions.
- **Notifications on the phone:** a bell and a notifications screen in the phone app (while the app is open).
- **Weekly automations:** schedules can run on chosen weekdays at a set time.
- **The timer's Agents section** shows which tasks your assistants are working on, live.
- PDF Studio: sections have a kind (front matter, chapter, back matter), and only chapters are numbered.

### Changed

- **Macs with Apple Silicon only:** Intel Macs are no longer built. 1.0.6 is the last Intel release, and it doesn't
  offer itself an update.
- The timer pill shows your time on the task today, not the task's all-time total.
- On very wide screens, file lists keep their details beside the names.

### Fixed

- "Show in folder" and Open work for shared files, instead of erroring.
- Files refuses names that differ only by case.
- Calendar: ending a future series, deleting a series with edited occurrences, and the month grid's days from the
  neighbouring months.
- Desktop: a window whose page hangs still closes, and Cmd+Q saves open edits first.
- Local mode repairs your project memberships even when the background service isn't running.

### Security

- The host refuses to fetch addresses inside your own network for anything a model or a member can supply.
  Calendar feeds and mailboxes that the owner adds keep their local reach.
- Mailbox tests and Gmail sign-in are limited to the mailbox's own user.
- Keys, tokens and passwords are kept out of logs and error messages.
- Cloud-model agent runs (pi) run in a sandbox that can't read your data or the rest of the disk.
- Approving an assistant's proposal re-checks that it's still within the chat's project.
- Dependency updates for the security advisories that had a non-breaking fix.

## [1.0.6] - 2026-11-04

- fix(tasks): review fixes for the unload save
- fix(tasks): save open edits when the window reloads or closes
- fix(tasks): clearing a task's cost, deadline or area saves
- fix(tasks): close the gaps the review found in the save on close
- fix(tasks): save the open task's edits when you switch projects
- fix(comments): review fixes for the composer and the tag picker's Create task
- fix(tasks): keep task edits when you leave the editor without saving
- fix(projects): the owner repair leaves personal containers alone
- fix(atlas): show a dash, not 0 B, for a this-device file's unknown size
- feat(comments): create a task from the update's tag picker
- feat(comments): a bigger comment field that grows, resizes and previews beside the text
- fix(comments): say "Open {project}'s Comments" instead of "Open the board"
- fix(atlas): Atlas > Files lists files stored only on this device
- ci(release): sign the .dmg before notarising it, and replace it by release id
- fix(projects): the owner is a member of local-mode projects, so Assignees lists them
- ci(release): notarise the Mac downloads once Apple's secrets exist
- fix(desktop): "---" stays three hyphens instead of turning into a long dash
- docs(changelog): 1.0.5 notes for users

## [1.0.5] - 2026-11-03

- The first release after a clean-up of the public repository; the earlier 1.0.x downloads were withdrawn. Apps from
  1.0.2 on update to this release by themselves; a 1.0.1 install needs this one installed once.
- A tab in its own folder now registers itself, and the server compiles optional tabs in when their files exist
  (`docs/dev/TAB_SPEC.md`).

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
