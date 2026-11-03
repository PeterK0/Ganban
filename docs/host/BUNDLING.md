# Building Ganban, and bundling the knowledge-base engine

This page covers building the Ganban apps yourself, and bundling **ragrat**, the knowledge-base engine, inside the
desktop app so a friend can install one file with nothing else to set up.

> **ragrat is coming later.** It isn't published yet, and Ganban works fully without it (Atlas and the AI overview
> say "not set up"). Until it is, use the **slim** builds below (`npm run build:desktop`, `npm run build:android`, the
> standalone server). Everything that mentions the engine, `build:release` and `build:desktop:full` included, needs a
> ragrat checkout and is here for when one is available.

ragrat is a Python project with a heavy dependency tree (Docling, torch, LanceDB…). On your own machine you can
install it once and point Ganban at it (Settings → AI Engines). To hand someone a single `.dmg` with no install
manual, you bundle a self-contained ragrat **inside the .app**.

This is opt-in: the normal `npm run tauri dev` and a slim `npm run tauri build` don't touch any of this. Ganban looks
for a bundled engine at runtime and prefers it; if there's none, it falls back to a ragrat installed on the system.

> **Status:** verified end-to-end on macOS (arm64): the frozen engine OCR'd a scanned PDF fully offline, daemon mode
> serves, and the unsigned .dmg mounts with the engine runnable inside the .app. On Windows the full bundle builds on
> real hardware (staged engine + `build:desktop:full` produced a valid MSI; NSIS is excluded, see the Windows
> section). The frozen engine's offline runtime on Windows still needs a real ingest smoke test.

## Build matrix (quick reference)

Each platform builds its **own** arch from a machine of that OS — artifacts never
cross platforms. `<ver>` = the `package.json` / Cargo version (currently 1.0.0).

| Platform | Output | Command | Lands at |
|---|---|---|---|
| **macOS** | Full `.dmg` + `.app` (engine bundled) | `npm run build:release` | `target/release/bundle/dmg/Ganban_<ver>_*.dmg` (+ `bundle/macos/Ganban.app`) |
| **macOS** | Full app, no staging/server | `npm run build:desktop:full` | `target/release/bundle/{dmg,macos}/` |
| **macOS** | Slim app (no engine, ~35 MB) | `npm run build:desktop` | same paths; finds a system ragrat at runtime |
| **Windows** | **Portable `.zip` (default)** | `npm run build:release` | `target\release\Ganban_<ver>_x64-portable.zip` |
| **Windows** | MSI wizard installer (opt-in) | `npm run build:release -- --installer` | `target\release\bundle\msi\Ganban_<ver>_x64_en-US.msi` — *currently unreliable; see Windows section* |
| **Windows** | Slim app (no engine) | `npm run build:desktop` | host-OS default bundle targets |
| **Android** | `.apk` | `npm run build:android` | under `src-tauri/gen/android/…` (Tauri prints the path) |
| **iOS** | app / `.ipa` | `npm run build:ios` | Xcode output (needs Apple dev signing) |
| **Linux** | *(not packaged)* | run the standalone server, or `tauri build` by hand | — no bundle recipe / overlay target yet |
| **Any (headless)** | Standalone `ganban-server` (web UI embedded) | `cargo build --release -p ganban-server --features embed-web` *(also built by `build:release`)* | `target/release/ganban-server[.exe]` — run via `npm run serve:headless` |

**Flags for `build:release`:** `--refresh-engine` (re-freeze the ragrat engine
after ragrat changes) · `--installer` (Windows: attempt the MSI instead of the
zip) · `--portable` (force the Windows zip — already the default; no-op on macOS).
macOS signing is env-driven (`APPLE_SIGNING_IDENTITY` + notarization vars, §5);
unsigned by default.

## The one-command path

With a ragrat clone sitting next to this checkout (or `RAGRAT_DIR` pointing at
one), a release for THIS machine is:

```bash
npm run build:release
```

It (1) reuses the staged engine artifacts or freezes them from the ragrat
clone and stages them, (2) builds the **full desktop installer** (engine +
models bundled), and (3) builds the **standalone `ganban-server`** binary with
the web UI embedded — and prints where everything landed.

**Finding the ragrat clone is zero-config after the first run.** `build:release`
resolves it in order: `$RAGRAT_DIR` → `.ragrat-dir` at the repo root (a
git-ignored memo) → `../ragrat`. Whatever resolves is written back to
`.ragrat-dir`, so once you've built once — even via `RAGRAT_DIR=/somewhere npm
run build:release` — every later build finds it automatically, wherever the
clone lives.

**Re-freezing after a ragrat change:** `npm run build:release -- --refresh-engine`
(or `REFRESH_ENGINE=1`). No more hand-deleting `src-tauri/resources/` — the flag
clears the staged artifacts and re-freezes.

Steps 1–2 below are what build:release automates; they remain for doing it by
hand (e.g. transferring artifacts instead of freezing locally).

## 1. Build the engine (in the ragrat repo)

```bash
cd /path/to/ragrat
packaging/build-bundle.sh      # PyInstaller onedir + Docling model download
# Windows: powershell -ExecutionPolicy Bypass -File packaging\build-bundle.ps1
```

Produces `dist/ragrat-engine/` (the frozen daemon) and `dist/docling-models/`
(pre-downloaded models, so first-launch ingest works offline). Build on the
platform AND architecture you ship — artifacts never cross platforms (an
arm64 macOS freeze is useless inside a Windows .exe).

## 2. Drop them into Ganban

```bash
cp -R /path/to/ragrat/dist/ragrat-engine   src-tauri/resources/
cp -R /path/to/ragrat/dist/docling-models  src-tauri/resources/
```

(`src-tauri/resources/{ragrat-engine,docling-models}` are git-ignored —
**every machine that runs the full build needs its own copy**; without them
the build fails the preflight in `scripts/check-bundle-resources.mjs`.)

Building on a different machine than the one that froze the engine? Transfer
with tar over SSH — it preserves the exec bits and, unlike AirDrop/browser
downloads, adds no Gatekeeper quarantine xattr to the binary:

```bash
tar -C /path/to/ragrat/dist -cf - ragrat-engine docling-models | \
  ssh other-mac tar -xf - -C /path/to/Ganban/src-tauri/resources
```

(Same CPU architecture required — an arm64 freeze only runs on Apple Silicon.)

## 3. Smoke-test the frozen engine offline (before any signing)

Cheapest place to catch the import/model failure modes — run the engine
straight out of `dist/`, fully pinned offline, and ingest one scanned PDF:

```bash
cd /path/to/ragrat
DOCLING_ARTIFACTS_PATH="$PWD/dist/docling-models" \
HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 DOCLING_DEVICE=cpu \
  dist/ragrat-engine/ragrat daemon --host 127.0.0.1 --port 8970
# then queue a scanned-PDF ingest against it and watch it complete (Wi-Fi off
# is the honest version of this test).
```

## 4. Build with the dist overlay

The `resources` + `macOS` keys live in the **committed overlay**
`src-tauri/tauri.dist.conf.json` — never in `tauri.conf.json`, which is shared
by every target (the same `bundle.resources` would drag the multi-GB engine
into the Android APK). Pass the overlay only for this build:

```bash
npm run build:desktop:full   # = tauri build --config src-tauri/tauri.dist.conf.json
```

(`npm run build:desktop` is the everyday slim build — ~35 MB, no engine, no
models — which discovers a system ragrat at runtime instead.)

Without signing env vars this produces an **unsigned** `.dmg`. On **Apple
Silicon**, Gatekeeper refuses a quarantined unsigned app with a misleading
**““Ganban.app” is damaged and can't be opened. You should move it to the Bin.”**
— and right-click → Open does *not* clear it (that path is only offered for the
gentler “unidentified developer” case, which is what Intel Macs show). The fix is
to strip the quarantine xattr the `.dmg` stamped on the copied app:

```bash
xattr -cr /Applications/Ganban.app    # or wherever it was dragged
open /Applications/Ganban.app
```

`-cr` clears it recursively, so the bundled engine's Mach-Os are freed too. This
is fine for handing a build to yourself or a friend, but every recipient has to
run it. **For a clean double-click on any Mac — the real fix — sign + notarize
(next section).** That's the only path Gatekeeper accepts without the xattr dance.

## 5. Sign the engine per-file, then build + notarize

Tauri signs the app shell but **not** the Mach-Os inside a bundled onedir, and
`codesign --deep` on the bare `ragrat-engine/` directory fails ("bundle format
unrecognized" — it's a plain directory, not a .app). Sign every Mach-O
individually, the main binary last:

```bash
IDENTITY="Developer ID Application: Your Name (TEAMID)"

find src-tauri/resources/ragrat-engine -type f ! -name ragrat -print0 |
  while IFS= read -r -d '' f; do
    file -b "$f" | grep -q 'Mach-O' || continue
    codesign --force -o runtime --timestamp \
      --entitlements src-tauri/entitlements.plist -s "$IDENTITY" "$f"
  done
codesign --force -o runtime --timestamp \
  --entitlements src-tauri/entitlements.plist -s "$IDENTITY" \
  src-tauri/resources/ragrat-engine/ragrat

APPLE_SIGNING_IDENTITY="$IDENTITY" \
  npm run tauri build -- --config src-tauri/tauri.dist.conf.json
# notarization additionally needs APPLE_ID / APPLE_PASSWORD / APPLE_TEAM_ID in env
```

Verify the result before shipping:

```bash
APP=src-tauri/target/release/bundle/macos/Ganban.app
codesign --verify --deep --strict "$APP"
spctl -a -vvv "$APP"
# the engine must still carry ITS entitlements (Tauri must not have re-signed it):
codesign -d --entitlements - "$APP/Contents/Resources/resources/ragrat-engine/ragrat"
ls "$APP/Contents/Resources/resources/ragrat-engine/ragrat"   # bundled? good.
```

## What runs at launch

`ai_engine.rs::bundled_ragrat` probes the resource dir for `ragrat-engine/ragrat`.
When found it spawns that (over any system ragrat) with:

- `DOCLING_ARTIFACTS_PATH` / `RAGRAT_DOCLING_MODELS` / `HF_HOME` → the bundled
  `docling-models/`
- `HF_HUB_OFFLINE=1`, `TRANSFORMERS_OFFLINE=1` → no model downloads, ever.
  Set for ANY bundled engine, even if `docling-models/` was forgotten — a
  packaging mistake then fails loudly at ingest instead of silently
  downloading gigabytes.
- `DOCLING_DEVICE=cpu`, `--workers <Settings value>`

Engine stdout/stderr land in `<app log dir>/ragrat-engine.log` (macOS:
`~/Library/Logs/com.scs.gansty/`) — the first place to look when an engine
"didn't become reachable"; a child that dies at startup also gets its exit
status and log tail inlined into the Settings error.

## Windows (full .exe) — recipe complete, first run pending

`npm run build:release` is the same one command (needs Node, Rust, `uv`, and
the ragrat clone; the freeze runs `packaging/build-bundle.ps1`). Signing is a
non-issue (unsigned → SmartScreen "More info → Run anyway"), and WebView2 is
preinstalled on current Windows 10/11. Verify before sharing:

1. **The portable zip is the default; NSIS is out and the MSI is unreliable.**
   NSIS dies at its ~2 GiB mmap ceiling on the engine+models payload (confirmed
   in the wild: `Internal compiler error #12345 ... out of range`), so it's
   **excluded from the bundle targets** in `tauri.dist.conf.json` (`["app",
   "dmg", "msi"]` — Tauri builds only the ones valid for the host OS). WiX/MSI
   *builds*, but has emitted a **corrupt package** on a tester's machine ("This
   installation package could not be opened"), so `build:release` ships the
   **portable zip** by default and the MSI is opt-in:
   - **`npm run build:release`** (the one command, **default on Windows**) stages
     the engine and emits `target\release\Ganban_<version>_x64-portable.zip`
     (built `--no-bundle`): no installer, no admin rights, unzip-and-run (engine +
     models in `resources\` beside the exe), and builds the standalone server.
   - **`npm run build:release -- --installer`** attempts the **MSI wizard**
     instead — `target\release\bundle\msi\Ganban_<version>_x64_en-US.msi`
     (Program Files, Start Menu shortcut, uninstaller, upgrade-in-place). It
     builds, but verify the package actually opens on a clean machine before
     relying on it (corrupt-package reports at this size).
   - **`npm run build:desktop:full`** builds just the bundle (no staging, no
     server) — needs the engine already staged.

   All need the WebView2 runtime, preinstalled on current Windows 10/11.

   **The MSI is a full wizard, by default — no custom WiX needed.** Tauri's
   stock template (verified at `tauri-cli-v2.11.2`:
   `crates/tauri-bundler/src/bundle/windows/msi/main.wxs`) already uses
   `<UIRef Id="WixUI_InstallDir" />` with `ConfigurableDirectory="INSTALLDIR"`,
   so the wizard runs: **Welcome → License → Destination Folder (Browse/Change)
   → Ready → Progress → Finish (☑ launch Ganban)**. It remembers a prior
   install dir (HKCU registry search) and upgrades in place. Don't fork the
   template to "add a wizard" — it's there.

   Optional polish, all config-only (no template fork), set in a Windows-only
   overlay so the Mac drag-install stays click-free — `bundle.licenseFile` is
   top-level and would otherwise add a license-accept step to the DMG:
   - **License page text**: the LicenseAgreementDlg always shows; without a
     file it's WiX's blank default. Point `bundle.licenseFile` at an **RTF**
     (WiX requires RTF, not txt/md) via a `--config` overlay passed only on
     Windows. A malformed RTF fails `light.exe`, so test the build after.
   - **Branded wizard art**: `bundle.windows.wix.bannerPath` (493×58 BMP, top
     band) and `dialogImagePath` (493×312 BMP, Welcome/Finish). Wrong size/
     format fails the build — test after.
2. **Smoke-test the frozen engine offline first**, exactly like step 3 above
   but with `dist\ragrat-engine\ragrat.exe` — the pyarrow/torch/onnxruntime
   collection in the spec is platform-neutral on paper, and macOS needed five
   real fixes before it ran, so assume Windows hides at least one more.
3. **Engine discovery is already Windows-shaped** (`ragrat.exe` probe,
   `USERPROFILE`, `where`, `%LOCALAPPDATA%` Ollama) — but it's untested there.

## Most likely failure modes (verify before shipping)

1. **OCR still hits the network on the first scanned PDF** despite the offline
   env (RapidOCR/HF edge cases). Test fully offline with caches wiped; confirm
   the `.onnx`/model files are physically under `docling-models/`.
2. **Notarization rejects the bundled engine** — every Mach-O must be signed
   individually with the hardened runtime + entitlements (step 5; `--deep` on
   the bare onedir directory errors out). Check `spctl -a -vvv` and
   `xcrun notarytool log`.
3. **pyarrow `dataset` / `pyarrow.vendored.version` missing** when LanceDB
   initializes — the spec's hidden-imports cover it; verify after a real ingest.
4. **torch/torchvision `_C` ImportError** — the spec's `--copy-metadata` +
   `_C` hidden-imports cover it.
5. **Size**: realistically a 3–5 GB `.dmg` (torch + Docling models). Drop
   formula enrichment / OCR in `ragrat/convert.py` if you want it smaller.

The PyInstaller spec is `packaging/ragrat-engine.spec` in the ragrat repo.
