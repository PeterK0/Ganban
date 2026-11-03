// Open Settings at a section from anywhere in the app: App listens for the event and opens
// the modal there. Used by screens that point at a setting ("set it up in Settings → …").

export type SettingsSection =
  | 'design' | 'notifications' | 'profile' | 'plugins' | 'connections' | 'models' | 'personalities' | 'loadouts'
  | 'tools' | 'sync' | 'account' | 'profiles' | 'data' | 'automations' | 'updates' | 'feedback' | 'diagnostics'
  | 'docs';

export const OPEN_SETTINGS = 'ganban:open-settings';

export function openSettings(section?: SettingsSection): void {
  window.dispatchEvent(new CustomEvent<SettingsSection | undefined>(OPEN_SETTINGS, { detail: section }));
}
