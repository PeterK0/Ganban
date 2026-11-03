#!/usr/bin/env node
// Preflight for the full (bundled-ragrat) desktop build: the engine + model
// artifacts are git-ignored, so every machine that builds the full bundle
// needs its own copy staged in src-tauri/resources/ — without this check,
// tauri dies with an unhelpful "glob pattern ... didn't match any files".
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const engineBin = process.platform === "win32" ? "ragrat.exe" : "ragrat";
const engine = join(root, "src-tauri", "resources", "ragrat-engine", engineBin);
const models = join(root, "src-tauri", "resources", "docling-models");

if (!existsSync(engine) || !existsSync(models)) {
  console.error(`✗ The full build needs the ragrat engine staged in src-tauri/resources/
  (git-ignored — this machine doesn't have it yet). Missing one or both of:
    src-tauri/resources/ragrat-engine/${engineBin}
    src-tauri/resources/docling-models/

  Easiest: run \`npm run build:release\` with a ragrat clone next to this
  checkout (or RAGRAT_DIR=/path/to/ragrat) — it freezes the engine and stages
  it automatically. Or stage by hand per docs/host/BUNDLING.md.

  For the everyday slim app (no bundled engine): npm run build:desktop`);
  process.exit(1);
}
console.log("✓ ragrat engine + docling models staged");
