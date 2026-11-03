/**
 * GIPHY GIF search, proxied through the host daemon: the API key is an
 * owner-only app_setting (`giphy_api_key`, Settings → Plug-ins) injected
 * server-side, so members get search results while the key never leaves the
 * host. GIF URLs are public CDN links, so they embed as plain markdown images
 * with no auth. The direct-fetch path survives only for the Settings "Test"
 * button (validating a key before saving it).
 */

import { daemonFetch, DaemonError } from "./daemon";

// Legacy per-device key storage — kept only so Settings can migrate an
// already-entered key to the host (prefill) and retire the local copy.
const KEY_STORAGE = "ganban-giphy-key";

export function getGiphyKey(): string | null {
  try {
    return localStorage.getItem(KEY_STORAGE);
  } catch {
    return null;
  }
}

export function setGiphyKey(key: string): void {
  const k = key.trim();
  if (k) localStorage.setItem(KEY_STORAGE, k);
  else localStorage.removeItem(KEY_STORAGE);
}

export interface Gif {
  id: string;
  url: string; // full GIF (for embedding)
  preview: string; // small preview (for the grid)
  title: string;
}

/** Thrown when the host has no GIPHY key saved — UIs show a "not configured"
 * state instead of an error banner. */
export class GifsNotConfigured extends Error {
  constructor() {
    super("GIF search is not configured on this host");
  }
}

function mapGifs(data: any): Gif[] {
  return (data?.data ?? [])
    .map((g: any) => ({
      id: String(g.id),
      url: g.images?.downsized?.url ?? g.images?.original?.url ?? "",
      preview: g.images?.fixed_width_small?.url ?? g.images?.preview_gif?.url ?? g.images?.downsized?.url ?? "",
      title: g.title || "gif",
    }))
    .filter((g: Gif) => g.url);
}

/** Search GIPHY (or trending when the query is empty) via the host proxy.
 * Pass `keyOverride` to validate a key without saving it (the Settings Test) —
 * only that path talks to api.giphy.com directly. */
export async function searchGifs(query: string, limit = 24, keyOverride?: string): Promise<Gif[]> {
  if (keyOverride !== undefined) {
    const key = keyOverride.trim();
    if (!key) throw new Error("No GIPHY key entered.");
    const q = query.trim();
    const base = q
      ? `https://api.giphy.com/v1/gifs/search?q=${encodeURIComponent(q)}`
      : `https://api.giphy.com/v1/gifs/trending?`;
    const res = await fetch(`${base}&api_key=${encodeURIComponent(key)}&limit=${limit}&rating=pg-13`);
    if (!res.ok) throw new Error(res.status === 401 || res.status === 403 ? "Invalid GIPHY key" : `GIPHY error ${res.status}`);
    return mapGifs(await res.json());
  }
  try {
    const data = await daemonFetch<unknown>(
      `/giphy/search?q=${encodeURIComponent(query.trim())}&limit=${limit}`,
      { method: "GET" },
    );
    return mapGifs(data);
  } catch (e) {
    if (e instanceof DaemonError && e.status === 404) throw new GifsNotConfigured();
    throw e;
  }
}
