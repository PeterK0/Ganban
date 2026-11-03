// Clock timezone preference (per-client display setting, stored in localStorage).
// Empty string = follow the system timezone.

const TZ_KEY = "ganban-timezone";

/** The chosen IANA timezone, or "" to follow the system. */
export function getTimezone(): string {
  try {
    return localStorage.getItem(TZ_KEY) ?? "";
  } catch {
    return "";
  }
}

/** Set (or clear, with "") the clock timezone. */
export function setTimezone(tz: string): void {
  try {
    if (tz) localStorage.setItem(TZ_KEY, tz);
    else localStorage.removeItem(TZ_KEY);
  } catch {
    /* ignore */
  }
}

/** The effective timezone (chosen, else the system's resolved zone). */
export function resolvedTimezone(): string {
  return getTimezone() || Intl.DateTimeFormat().resolvedOptions().timeZone;
}

// undefined timeZone tells Intl to use the system zone.
const tzOpt = (): string | undefined => getTimezone() || undefined;

/** HH:MM:SS in the chosen timezone. */
export function formatClockTime(date: Date): string {
  return date.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZone: tzOpt(),
  });
}

/** Weekday Mon D, in the chosen timezone. */
export function formatClockDate(date: Date): string {
  return date.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: tzOpt(),
  });
}

/** Short timezone label for `date` (e.g. "PST", "GMT+1") in the chosen zone. */
export function timezoneLabel(date: Date): string {
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: tzOpt(), timeZoneName: "short" }).formatToParts(date);
    return parts.find((p) => p.type === "timeZoneName")?.value ?? "";
  } catch {
    return "";
  }
}

const FALLBACK_ZONES = [
  "UTC",
  "America/Los_Angeles",
  "America/Denver",
  "America/Chicago",
  "America/New_York",
  "America/Sao_Paulo",
  "Europe/London",
  "Europe/Paris",
  "Europe/Berlin",
  "Europe/Moscow",
  "Asia/Dubai",
  "Asia/Kolkata",
  "Asia/Shanghai",
  "Asia/Tokyo",
  "Australia/Sydney",
  "Pacific/Auckland",
];

/** The full IANA timezone list (browser-provided), or a curated fallback. */
export function timezoneList(): string[] {
  try {
    const supported = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf;
    if (supported) return supported("timeZone");
  } catch {
    /* ignore */
  }
  return FALLBACK_ZONES;
}
