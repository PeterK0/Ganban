// Open things with this machine's own apps: a folder or file with its default app, a link in the
// default browser. The desktop app does it in Rust (src-tauri/src/system_open.rs), which on Linux
// uses the system's opener with the user's own environment, also from the AppImage. The phone
// app keeps the opener plugin.

async function onPhone(): Promise<boolean> {
  const { isMobilePlatform } = await import('./daemon');
  return isMobilePlatform();
}

/** Open a folder or file on this machine with its default app (desktop app). */
export async function openPathHere(path: string): Promise<void> {
  if (await onPhone()) {
    const { openPath } = await import('@tauri-apps/plugin-opener');
    return openPath(path);
  }
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('system_open_path', { path });
}

/** Open a web, mail or phone link outside Ganban (the installed app; throws in a browser). */
export async function openLinkHere(url: string): Promise<void> {
  if (await onPhone()) {
    const { openUrl } = await import('@tauri-apps/plugin-opener');
    return openUrl(url);
  }
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('system_open_url', { url });
}
