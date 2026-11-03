# Bundled engines (distribution builds only)

This directory is where a **bundled ragrat engine** goes so a downloaded `.dmg`
runs with zero Python/dependency setup. It is empty in the repo and **git-ignored**
— normal `npm run tauri dev` and a self-use desktop build don't need it (Ganban
falls back to a system-installed ragrat, configured in Settings → AI Engines).

To cut a distributable build, drop two folders here:

```
src-tauri/resources/
  ragrat-engine/     # PyInstaller onedir (the `ragrat` exe + _internal/)
  docling-models/    # pre-downloaded Docling models (offline first-launch)
```

Produce them from the ragrat repo: `packaging/build-bundle.sh`, then follow
`docs/host/BUNDLING.md` (enable the resources in tauri.conf, deep-sign, build, notarize).

`ai_engine.rs::bundled_ragrat` discovers `ragrat-engine/ragrat` here at runtime
and, when present, launches it with the offline Docling env pointing at
`docling-models/` — preferring it over any system ragrat.
