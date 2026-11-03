{pkgs ? import <nixpkgs> {}}:
pkgs.mkShell {
  buildInputs = with pkgs; [
    # Core toolchains
    nodejs_20
    rustc
    cargo
    rustfmt
    rust-analyzer
    pkg-config

    # Tauri system deps (Linux equivalents of the apt list)
    webkitgtk_4_1
    gtk3
    libsoup_3
    openssl
    librsvg
    libayatana-appindicator
    glib
    cairo
    pango
    gdk-pixbuf
    atk

    # Additional dependencies for bundling
    xdg-utils
    file
    desktop-file-utils
  ];

  shellHook = ''
    export PKG_CONFIG_PATH="${pkgs.webkitgtk_4_1.dev}/lib/pkgconfig:$PKG_CONFIG_PATH"
    export GIO_MODULE_DIR="${pkgs.glib-networking}/lib/gio/modules/"
    export WEBKIT_DISABLE_COMPOSITING_MODE=1
    export WEBKIT_DISABLE_DMABUF_RENDERER=1

    # 4K HiDPI scaling
    export GDK_SCALE=2.0
    export GDK_DPI_SCALE=1.5
    export QT_SCALE_FACTOR=2.0
  '';
}
