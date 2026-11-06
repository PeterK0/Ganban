# Linux packaging

The release workflow (`.github/workflows/release.yml`) builds three Linux packages on the oldest supported Ubuntu:
the `.AppImage`, the `.deb` and the `.rpm`. `packaging/arch/PKGBUILD` turns the released `.deb` into an Arch package.
All of them run natively on Wayland, and on X11 where that's the session: GTK picks the backend, nothing forces one.

## The AppImage uses the system's graphics stack

Tauri's AppImage (linuxdeploy and its GTK plugin) bundles the build machine's libraries, the Wayland client libraries
among them, and its GTK hook exports `GDK_BACKEND=x11`. On a rolling distribution the old `libwayland-*` clash with
the system's newer Mesa, and WebKitGTK stops at launch: `Could not create default EGL display: EGL_BAD_PARAMETER`.

So after Tauri builds it, the Linux job runs `scripts/appimage-system-graphics.sh fix`:

1. Extract the AppImage (`--appimage-extract`) and cut its runtime off (`--appimage-offset` bytes).
2. **Strip:** remove the graphics driver stack's client libraries: `libwayland-*`, `libEGL*`, `libGL.so*`, `libGLX*`,
   `libGLdispatch*`, `libOpenGL*`, `libgbm*`, `libdrm*`, `libglapi*`. Tauri's AppImage carries only the four
   `libwayland-{client,cursor,egl,server}`; the rest are listed in case a future linuxdeploy adds them. Then delete
   the hook's `export GDK_BACKEND=…` line. WebKitGTK, GTK and everything else stay bundled.
3. **Verify:** none of those libraries is left, no hook sets `GDK_BACKEND`, and `ldd` on `usr/bin/*` and WebKit's
   processes shows every graphics library resolving from the system. It prints what stays bundled.
4. **Repack** with appimagetool, pinned by version and checksum in the workflow, and the AppImage's own runtime
   (`--runtime-file`), so the runtime is the one Tauri shipped.

The workflow then extracts the new AppImage and verifies it again, re-signs it for the updater
(`tauri signer sign`) and, on a tag, replaces the `.AppImage` and its `.sig` on the draft release. A manual run's
`desktop-linux` artifact holds the repacked AppImage.

`npm run test:appimage` tests strip and verify on a fake AppDir.

## The Arch package

`packaging/arch/PKGBUILD` builds `ganban-bin` (the AUR name for a prebuilt binary): it downloads the release's
`.deb` for `pkgver`, checks its `sha256sums`, and installs its contents (`/usr/bin/gansty`, the `.desktop` entry, the
icons) onto the system's own libraries. `depends` are the `.deb`'s `Depends` in Arch's names, plus the libraries the
binary links directly.

It also writes `pacman` into `/usr/share/ganban/package-manager`. The desktop app reads that marker beside its
executable (`<prefix>/share/ganban/package-manager` for `<prefix>/bin/gansty`), doesn't register the updater, and
Settings → Updates says it's updated by the package manager ([UPDATES.md](../design/UPDATES.md#the-desktop-app)).
Another distribution's package can write its own manager's name there.

To release a new version of the package: set `pkgver`, reset `pkgrel=1`, run `updpkgsums`, then `makepkg -si`.

On manual runs, the `arch-package` job builds the package in an `archlinux` container from the run's `.deb`,
installs it, and checks the files, the marker and that `ldd /usr/bin/gansty` finds every library.
