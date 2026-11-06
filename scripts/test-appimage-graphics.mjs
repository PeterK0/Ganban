// Tests scripts/appimage-system-graphics.sh (strip and verify) on a fake AppDir laid out like
// Tauri's AppImage: the graphics client libraries go, WebKitGTK and the rest stay, and the GTK hook
// no longer forces GDK_BACKEND=x11.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const script = new URL('./appimage-system-graphics.sh', import.meta.url).pathname;
const run = (...args) => execFileSync('bash', [script, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

const dir = mkdtempSync(join(tmpdir(), 'appdir-'));
try {
  const lib = join(dir, 'usr/lib');
  mkdirSync(lib, { recursive: true });
  mkdirSync(join(dir, 'usr/bin'), { recursive: true });
  mkdirSync(join(dir, 'apprun-hooks'));
  const graphics = ['libwayland-client.so.0', 'libwayland-cursor.so.0', 'libwayland-egl.so.1', 'libwayland-server.so.0', 'libEGL.so.1', 'libGLX.so.0', 'libGLdispatch.so.0', 'libgbm.so.1', 'libdrm.so.2', 'libglapi.so.0'];
  const kept = ['libwebkit2gtk-4.1.so.0', 'libgtk-3.so.0', 'libepoxy.so.0', 'libxkbcommon.so.0', 'libgstgl-1.0.so.0', 'libgdk-3.so.0'];
  for (const f of [...graphics, ...kept]) writeFileSync(join(lib, f), '');
  symlinkSync('libdrm.so.2', join(lib, 'libdrm.so'));
  const hook = join(dir, 'apprun-hooks/linuxdeploy-plugin-gtk.sh');
  writeFileSync(hook, '#! /usr/bin/env bash\nexport GTK_DATA_PREFIX="$APPDIR"\nexport GDK_BACKEND=x11 # Crash with Wayland backend\nexport GTK_PATH="$APPDIR//usr/lib/gtk-3.0"\n');

  // verify refuses the AppDir as Tauri builds it.
  assert.throws(() => run('verify', dir), /still bundled/);

  const out = run('strip', dir);
  for (const f of graphics) {
    assert.ok(!existsSync(join(lib, f)), `${f} removed`);
    assert.match(out, new RegExp(`removed usr/lib/${f.replace(/\./g, '\\.')}`));
  }
  assert.ok(!existsSync(join(lib, 'libdrm.so')), 'symlinks too');
  for (const f of kept) assert.ok(existsSync(join(lib, f)), `${f} kept`);
  const h = readFileSync(hook, 'utf8');
  assert.ok(!h.includes('GDK_BACKEND'), 'the forced backend is gone');
  assert.ok(h.includes('GTK_PATH') && h.includes('GTK_DATA_PREFIX'), 'the rest of the hook stays');
  assert.match(out, /unset the forced GDK_BACKEND/);

  // verify passes now and lists what's bundled.
  const v = run('verify', dir);
  assert.match(v, /libwebkit2gtk-4\.1\.so\.0/);
  assert.doesNotMatch(v, /libwayland/);

  // Running strip again changes nothing.
  assert.doesNotMatch(run('strip', dir), /removed|unset/);
  assert.throws(() => run('strip', join(dir, 'nope')), /isn't an AppDir/);
  console.log('appimage-system-graphics: ok');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
