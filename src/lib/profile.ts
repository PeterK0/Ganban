/**
 * User profiles: a frontend-owned JSON blob stored on the user (`profile_json`).
 * Holds the chosen display theme, a resized avatar data-URL, vCard-style contact
 * fields, and theme-specific "flavor" fields. The backend stores it verbatim.
 */

import type { CSSProperties } from "react";

export type ProfileTheme = "character" | "formal" | "minimal" | "card";
export type CardBorder = "soft" | "none" | "bold" | "glow";

/** Resolved colors a card renders with, derived from the chosen background. */
export interface CardPalette {
  bg: string;
  fg: string;
  muted: string;
  accent: string;
}

/** Selectable card backgrounds. "theme" tracks the app theme via CSS vars; the
 * rest are fixed palettes (incl. a couple of gradients). */
export const CARD_BACKGROUNDS: { key: string; label: string; palette: CardPalette }[] = [
  { key: "theme", label: "Match theme", palette: { bg: "var(--color-surface-0)", fg: "var(--color-text)", muted: "var(--color-subtext-0)", accent: "var(--color-primary)" } },
  { key: "parchment", label: "Parchment", palette: { bg: "#efe6d0", fg: "#3b2f1c", muted: "#7a5c2e", accent: "#b9a77f" } },
  { key: "paper", label: "Paper", palette: { bg: "#f6f4ee", fg: "#2b2b2b", muted: "#6b6b6b", accent: "#9b8e74" } },
  { key: "slate", label: "Slate", palette: { bg: "#2b303b", fg: "#e6e9ef", muted: "#9aa0ac", accent: "#7c93c9" } },
  { key: "graphite", label: "Graphite", palette: { bg: "#1b1b20", fg: "#ededf2", muted: "#9a9aa6", accent: "#8a8a99" } },
  { key: "midnight", label: "Midnight", palette: { bg: "#11182f", fg: "#dfe6ff", muted: "#8a93b8", accent: "#5b78d6" } },
  { key: "ocean", label: "Ocean", palette: { bg: "#0f2230", fg: "#d9eefb", muted: "#8bb3c9", accent: "#3fa8d6" } },
  { key: "forest", label: "Forest", palette: { bg: "#14241b", fg: "#dff0e4", muted: "#8fb39a", accent: "#5fae77" } },
  { key: "plum", label: "Plum", palette: { bg: "#241830", fg: "#f0e2f5", muted: "#b89ac2", accent: "#a875c9" } },
  { key: "rose", label: "Rose", palette: { bg: "#2e1820", fg: "#ffe3ec", muted: "#cf9bad", accent: "#e0728f" } },
  { key: "sunset", label: "Sunset", palette: { bg: "linear-gradient(135deg,#3a2350,#7a3b5a)", fg: "#ffe8ee", muted: "#e0b8c8", accent: "#f0a36a" } },
  { key: "aurora", label: "Aurora", palette: { bg: "linear-gradient(135deg,#0f2a3a,#1e5060)", fg: "#dbf5ff", muted: "#9ed0e0", accent: "#5fe0c0" } },
];

export const CARD_BORDERS: { key: CardBorder; label: string }[] = [
  { key: "soft", label: "Soft" },
  { key: "none", label: "None" },
  { key: "bold", label: "Bold" },
  { key: "glow", label: "Glow" },
];

/** A sensible default background per theme when the user hasn't picked one. */
export const DEFAULT_BACKGROUND: Record<ProfileTheme, string> = {
  character: "parchment",
  formal: "theme",
  minimal: "theme",
  card: "midnight",
};

/** A text color (black or white) that reads on `color`. Hex only; for CSS-var
 * accents (the "theme" palette) callers fall back to --color-primary-text. */
export function readableText(color: string): string {
  const m = /^#([0-9a-f]{6})$/i.exec(color.trim());
  if (!m) return "#ffffff";
  const n = parseInt(m[1], 16);
  const lum = (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
  return lum > 0.55 ? "#1a1a1a" : "#ffffff";
}

/** Resolve the palette a profile's card should use. */
export function cardPalette(p: Profile): CardPalette {
  const key = p.background || DEFAULT_BACKGROUND[p.theme] || "theme";
  return (CARD_BACKGROUNDS.find((b) => b.key === key) ?? CARD_BACKGROUNDS[0]).palette;
}

/** Inline style for the card container (background + border, per the choices). */
export function cardStyle(p: Profile): CSSProperties {
  const pal = cardPalette(p);
  const style: CSSProperties = { background: pal.bg, color: pal.fg };
  switch (p.border || "soft") {
    case "none":
      style.border = "none";
      break;
    case "bold":
      style.border = `2.5px solid ${pal.accent}`;
      break;
    case "glow":
      style.border = `1.5px solid ${pal.accent}`;
      style.boxShadow = `0 0 18px ${pal.accent}55`;
      break;
    default:
      style.border = `1px solid ${pal.accent}66`;
  }
  return style;
}

export interface AbilityScores {
  str?: string;
  dex?: string;
  con?: string;
  int?: string;
  wis?: string;
  cha?: string;
}

export interface Profile {
  theme: ProfileTheme;
  background?: string; // CARD_BACKGROUNDS key
  border?: CardBorder;
  avatar?: string; // data URL (resized square)
  title?: string; // role / job title
  organization?: string;
  email?: string;
  phone?: string;
  location?: string;
  pronouns?: string;
  website?: string;
  bio?: string;
  /** Character-sheet flavor. */
  dnd?: { class?: string; race?: string; level?: string; alignment?: string; stats?: AbilityScores };
  /** Trading-card flavor. */
  card?: { tagline?: string; rarity?: string; powerLabel?: string; power?: string };
  /** Personal custom emojis (`:name:`) that travel with the account across
   * projects. Rendered for this user; the host's shared set renders for everyone. */
  customEmojis?: { name: string; image: string }[];
}

export const PROFILE_THEMES: { key: ProfileTheme; label: string }[] = [
  { key: "character", label: "Character sheet" },
  { key: "formal", label: "Formal card" },
  { key: "minimal", label: "Minimal" },
  { key: "card", label: "Trading card" },
];

export const ABILITIES: (keyof AbilityScores)[] = ["str", "dex", "con", "int", "wis", "cha"];

export function blankProfile(): Profile {
  return { theme: "minimal" };
}

/** Parse a stored `profile_json` into a Profile (tolerant of missing/invalid). */
export function parseProfile(profileJson?: string | null): Profile {
  if (!profileJson) return blankProfile();
  try {
    const p = JSON.parse(profileJson);
    if (p && typeof p === "object") return { ...blankProfile(), ...p };
  } catch {
    /* ignore malformed */
  }
  return blankProfile();
}

export function serializeProfile(p: Profile): string {
  return JSON.stringify(p);
}

/** Initials fallback for an avatar (e.g. "Sam Vimes" → "SV"). */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/**
 * Resize an image File to a square `size`×`size` JPEG data URL (cover-crop), so
 * the avatar stays small enough to live inline on the user row.
 */
export async function imageToAvatarDataUrl(file: File, size = 192): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas not supported");
  const scale = Math.max(size / bitmap.width, size / bitmap.height);
  const w = bitmap.width * scale;
  const h = bitmap.height * scale;
  ctx.drawImage(bitmap, (size - w) / 2, (size - h) / 2, w, h);
  bitmap.close?.();
  return canvas.toDataURL("image/jpeg", 0.82);
}

/**
 * Resize an image to a `size`×`size` PNG data URL for a custom emoji — PNG to
 * PRESERVE transparency, and contain-fit (not cropped) so the whole glyph shows.
 */
export async function imageToEmojiDataUrl(file: File, size = 64): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas not supported");
  const scale = Math.min(size / bitmap.width, size / bitmap.height); // contain
  const w = bitmap.width * scale;
  const h = bitmap.height * scale;
  ctx.drawImage(bitmap, (size - w) / 2, (size - h) / 2, w, h);
  bitmap.close?.();
  return canvas.toDataURL("image/png"); // keeps alpha
}
