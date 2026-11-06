#!/usr/bin/env bash
# Make the Linux AppImage use the system's graphics stack, so it runs natively on Wayland on current
# distributions (docs/dev/LINUX_PACKAGING.md).
#
# The AppImage is built on the oldest supported Ubuntu, and linuxdeploy bundles that Ubuntu's Wayland
# client libraries. On a rolling distribution they clash with the system's newer Mesa/EGL ("Could not
# create default EGL display: EGL_BAD_PARAMETER"). Its GTK hook also forces GDK_BACKEND=x11. This
# removes the graphics client libraries (they must match the system's driver stack, and every
# desktop with a GPU driver has them) and the forced backend, so GTK picks the backend itself.
# WebKitGTK and everything else stay bundled.
#
#   appimage-system-graphics.sh fix <file.AppImage> <appimagetool>   extract, strip, verify, repack in place
#   appimage-system-graphics.sh strip <AppDir>                        remove the libraries and the forced backend
#   appimage-system-graphics.sh verify <AppDir>                       assert they're gone; ldd shows where they resolve
#
# `fix` repacks with the AppImage's own runtime (--runtime-file), so the type-2 runtime stays the
# one Tauri shipped and nothing unpinned is downloaded.
set -euo pipefail

# The libraries that belong to the system's graphics driver stack.
PATTERNS=('libwayland-*' 'libEGL*' 'libGL.so*' 'libGLX*' 'libGLdispatch*' 'libOpenGL*' 'libgbm*' 'libdrm*' 'libglapi*')

die() { echo "error: $*" >&2; exit 1; }

find_graphics() {
  local dir="$1" args=() p
  for p in "${PATTERNS[@]}"; do args+=(-name "$p" -o); done
  unset 'args[${#args[@]}-1]'
  find "$dir" \( -type f -o -type l \) \( "${args[@]}" \) | LC_ALL=C sort
}

hooks() { find "$1" -maxdepth 2 -path '*apprun-hooks/*.sh' -type f | LC_ALL=C sort; }

strip_appdir() {
  local dir="$1" f h
  [ -d "$dir/usr" ] || die "$dir isn't an AppDir (no usr/)"
  while IFS= read -r f; do
    echo "removed ${f#"$dir"/}"
    rm -f "$f"
  done < <(find_graphics "$dir")
  # linuxdeploy-plugin-gtk's hook exports GDK_BACKEND=x11; GTK chooses on its own without it.
  while IFS= read -r h; do
    if grep -q '^[[:space:]]*export GDK_BACKEND=' "$h"; then
      sed -i.bak '/^[[:space:]]*export GDK_BACKEND=/d' "$h" && rm -f "$h.bak"
      echo "unset the forced GDK_BACKEND in ${h#"$dir"/}"
    fi
  done < <(hooks "$dir")
}

verify_appdir() {
  local dir="$1" left h bin out bad=0
  left="$(find_graphics "$dir")"
  [ -z "$left" ] || die "graphics libraries still bundled: $left"
  while IFS= read -r h; do
    if grep -q 'GDK_BACKEND' "$h"; then die "${h#"$dir"/} still sets GDK_BACKEND"; fi
  done < <(hooks "$dir")
  echo "bundled libraries:"
  find "$dir/usr/lib" -maxdepth 1 -name '*.so*' -exec basename {} \; | LC_ALL=C sort | sed 's/^/  /'
  command -v ldd > /dev/null || { echo "(no ldd here: skipped the resolution check)"; return 0; }
  # Every graphics library the app and WebKit's processes load resolves from the system.
  for bin in "$dir"/usr/bin/* "$dir"/usr/lib/*/webkit2gtk-4.1/WebKit*Process; do
    [ -f "$bin" ] && file -b "$bin" | grep -q ELF || continue
    out="$(ldd "$bin" | grep -E 'lib(wayland|EGL|GL|GLX|GLdispatch|OpenGL|gbm|drm|glapi)[-.]' || true)"
    echo "${bin#"$dir"/}:"
    echo "${out:-  (none linked)}" | sed 's/^[[:space:]]*/  /'
    # The bundled binaries' RUNPATH ($ORIGIN/../lib) would point ldd at a bundled copy.
    if grep -qF "$dir" <<< "$out"; then echo "  ^ resolves inside the AppDir" >&2; bad=1; fi
    if grep -q 'not found' <<< "$out"; then echo "  ^ not found on this system" >&2; bad=1; fi
  done
  [ "$bad" = 0 ] || die "a graphics library doesn't resolve from the system"
}

fix_appimage() {
  local img tool offset
  img="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
  tool="$(cd "$(dirname "$2")" && pwd)/$(basename "$2")"
  [ -f "$img" ] || die "no AppImage at $1"
  [ -x "$tool" ] || die "appimagetool at $2 isn't executable"
  work="$(mktemp -d)"
  trap 'rm -rf "$work"' EXIT
  chmod +x "$img"
  (cd "$work" && "$img" --appimage-extract > /dev/null)
  offset="$("$img" --appimage-offset)"
  head -c "$offset" "$img" > "$work/runtime"
  strip_appdir "$work/squashfs-root"
  verify_appdir "$work/squashfs-root"
  ARCH=x86_64 "$tool" --appimage-extract-and-run --no-appstream --comp zstd \
    --runtime-file "$work/runtime" "$work/squashfs-root" "$work/out.AppImage"
  chmod +x "$work/out.AppImage"
  mv "$work/out.AppImage" "$img"
  echo "repacked $img"
}

case "${1:-}" in
  fix) [ $# = 3 ] || die "usage: $0 fix <file.AppImage> <appimagetool>"; fix_appimage "$2" "$3" ;;
  strip) [ $# = 2 ] || die "usage: $0 strip <AppDir>"; strip_appdir "$2" ;;
  verify) [ $# = 2 ] || die "usage: $0 verify <AppDir>"; verify_appdir "$2" ;;
  *) die "usage: $0 fix|strip|verify …" ;;
esac
