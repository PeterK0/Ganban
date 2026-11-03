#!/usr/bin/env node
// One-command release build for THIS machine:
//   1. ragrat engine artifacts — reused if staged, otherwise frozen from a
//      ragrat clone (../ragrat next to this checkout, or $RAGRAT_DIR) and
//      staged into src-tauri/resources/.
//   2. the FULL desktop app (installer with the bundled engine + models).
//   3. the standalone `ganban-server` binary (web UI embedded), for headless
//      self-hosting.
// Works on macOS and Windows; each platform builds its own arch — artifacts
// never cross platforms (an arm64 freeze is useless inside a Windows .exe).
//
// Refresh the engine after ragrat changes by deleting the staged copies:
//   rm -rf src-tauri/resources/{ragrat-engine,docling-models}   (mac)
//   rmdir /s src-tauri\resources\ragrat-engine ...              (win)
import { spawnSync } from "node:child_process";
import { existsSync, cpSync, rmSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const win = process.platform === "win32";
const resources = join(root, "src-tauri", "resources");
const engineBin = win ? "ragrat.exe" : "ragrat";

function run(cmd, cwd = root) {
  console.log(`\n▶ ${cmd}`);
  const r = spawnSync(cmd, { cwd, stdio: "inherit", shell: true });
  if (r.status !== 0) {
    console.error(`✗ failed (exit ${r.status}): ${cmd}`);
    process.exit(r.status ?? 1);
  }
}

// ---- 1. Engine artifacts: reuse staged, else freeze from the ragrat clone.
// Find the ragrat clone without re-typing a path every time:
//   1. $RAGRAT_DIR (explicit override, always wins)
//   2. .ragrat-dir at repo root (remembered from a previous run — git-ignored)
//   3. ../ragrat next to this checkout (the convention)
// Whatever resolves is written back to .ragrat-dir, so the NEXT build on this
// machine is zero-config regardless of where the clone actually lives.
const ragratMemo = join(root, ".ragrat-dir");
function resolveRagrat() {
  const candidates = [
    process.env.RAGRAT_DIR,
    existsSync(ragratMemo) ? readFileSync(ragratMemo, "utf8").trim() : null,
    join(root, "..", "ragrat"),
  ].filter(Boolean);
  for (const c of candidates) {
    if (existsSync(join(c, "packaging"))) {
      try {
        writeFileSync(ragratMemo, c); // remember for next time
      } catch {} // best-effort; a read-only checkout still builds
      return c;
    }
  }
  return null;
}

// `--refresh-engine` (or REFRESH_ENGINE=1): re-freeze even if already staged —
// the one-flag way to pick up ragrat changes without hand-deleting resources.
const refreshEngine = process.argv.includes("--refresh-engine") || process.env.REFRESH_ENGINE === "1";
if (refreshEngine) {
  for (const dir of ["ragrat-engine", "docling-models"]) rmSync(join(resources, dir), { recursive: true, force: true });
  console.log("▶ --refresh-engine: cleared staged artifacts, will re-freeze");
}

const engineStaged = existsSync(join(resources, "ragrat-engine", engineBin));
const modelsStaged = existsSync(join(resources, "docling-models"));
if (engineStaged && modelsStaged) {
  console.log("✓ ragrat engine already staged (re-freeze with `npm run build:release -- --refresh-engine`)");
} else {
  const ragrat = resolveRagrat();
  if (!ragrat) {
    console.error(`✗ No staged engine and no ragrat clone found.
  Looked at: $RAGRAT_DIR, ${ragratMemo}, ${join(root, "..", "ragrat")}
  Clone the (private) ragrat repo (it must contain a packaging/ dir) and either
  put it at ../ragrat, set RAGRAT_DIR=/path/to/ragrat once, or write the path
  into .ragrat-dir. After the first successful run the path is remembered.`);
    process.exit(1);
  }
  console.log(`▶ Freezing the ragrat engine from ${ragrat} (first run downloads models — takes a while)`);
  run(
    win
      ? "powershell -ExecutionPolicy Bypass -File packaging\\build-bundle.ps1"
      : "sh packaging/build-bundle.sh",
    ragrat,
  );
  for (const dir of ["ragrat-engine", "docling-models"]) {
    const from = join(ragrat, "dist", dir);
    const to = join(resources, dir);
    if (!existsSync(from)) {
      console.error(`✗ expected ${from} after the freeze — check the ragrat build output`);
      process.exit(1);
    }
    rmSync(to, { recursive: true, force: true });
    cpSync(from, to, { recursive: true }); // preserves the exec bit
    console.log(`✓ staged ${dir}`);
  }
}

// ---- 2. Full desktop app.
//   macOS   → .dmg installer (the else branch; dist overlay's `targets`).
//   Windows → a no-install PORTABLE ZIP by default. The installer formats both
//     choke on the ~2.4 GB engine+models payload: makensis (NSIS) is 32-bit and
//     dies mmapping it, and WiX/MSI emits a CORRUPT package ("This installation
//     package could not be opened" — confirmed on a tester's machine). The zip
//     is unzip-and-run, no admin rights, and reliable at this size.
//     Pass --installer to attempt the (currently broken) MSI anyway.
// `--installer` is also settable via INSTALLER=1 (and --portable via PORTABLE=1,
// --refresh-engine via REFRESH_ENGINE=1). Env vars are shell-agnostic and
// ALWAYS reach the process — unlike `--` args, which some Windows npm/shell
// combos silently drop (verified: a `npm run build:release -- --refresh-engine
// --installer` run took the zip branch, meaning neither flag reached argv).
const installerMode =
  process.argv.includes("--installer") || process.env.INSTALLER === "1";
const portableZip =
  process.argv.includes("--portable") ||
  process.env.PORTABLE === "1" ||
  (win && !installerMode);
let desktopArtifact;
if (win && portableZip) {
  run("node scripts/check-bundle-resources.mjs");
  run("npx tauri build --config src-tauri/tauri.dist.conf.json --no-bundle");
  const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
  const portable = join(root, "target", "release", "Ganban-portable");
  console.log("\n▶ Assembling the portable app (engine + models beside the exe)");
  // --no-bundle skips the productName rename (that's a bundling step), so the
  // raw binary keeps the cargo name; ship it under the user-facing one.
  const exe = ["Ganban.exe", "gansty.exe"]
    .map((n) => join(root, "target", "release", n))
    .find(existsSync);
  if (!exe) {
    console.error("✗ built binary not found in target/release (expected Ganban.exe or gansty.exe)");
    process.exit(1);
  }
  rmSync(portable, { recursive: true, force: true });
  mkdirSync(portable, { recursive: true });
  cpSync(exe, join(portable, "Ganban.exe"));
  // Same layout the runtime probes: <exe dir>/resources/ragrat-engine/...
  for (const dir of ["ragrat-engine", "docling-models"]) {
    cpSync(join(resources, dir), join(portable, "resources", dir), { recursive: true });
  }
  const zip = join(root, "target", "release", `Ganban_${version}_x64-portable.zip`);
  rmSync(zip, { force: true });
  // bsdtar ships with Windows 10+; -a picks zip64 from the extension (no 2 GiB limit).
  run(`tar -a -cf "${zip}" -C "${portable}" .`);
  desktopArtifact = zip;
} else {
  run("npm run build:desktop:full");
  desktopArtifact = win
    ? `${join(root, "target", "release", "bundle", "msi")}\\Ganban_<version>_x64_en-US.msi`
    : `${join(root, "target", "release", "bundle")} (dmg/, macos/)`;
}

// ---- 3. Standalone server (embed-web: the touch UI is baked in). dist/ is
// fresh — the tauri build's beforeBuildCommand just rebuilt it.
run("cargo build --release -p ganban-server --features embed-web");

// ---- Where everything landed.
const winHint = win
  ? portableZip
    ? "\n  (unzip anywhere and run Ganban.exe — needs the WebView2 runtime, preinstalled on current Windows)"
    : "\n  (double-click the .msi — installs with a wizard; needs the WebView2 runtime, preinstalled on current Windows)"
  : "";
console.log(`
✔ Release build complete.
  Desktop app:       ${desktopArtifact}${winHint}
  Standalone server: ${join(root, "target", "release", win ? "ganban-server.exe" : "ganban-server")}
`);
