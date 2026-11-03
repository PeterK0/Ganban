import type { CSSProperties } from "react";
import type { CardPalette, Profile } from "../lib/profile";
import { ABILITIES, cardPalette, cardStyle, initials, readableText } from "../lib/profile";

/** Renders a user's profile in its chosen theme + background/border. Shared by
 * the desktop app and the touch UI; self-contained, palette-driven styling. */
export default function ProfileCard({
  name,
  username,
  profile,
}: {
  name: string;
  username?: string;
  profile: Profile;
}) {
  const pal = cardPalette(profile);
  const style = cardStyle(profile);
  const common = { name, username, p: profile, pal, style };
  switch (profile.theme) {
    case "character":
      return <CharacterSheet {...common} />;
    case "formal":
      return <FormalCard {...common} />;
    case "card":
      return <TradingCard {...common} />;
    default:
      return <MinimalCard {...common} />;
  }
}

type LayoutProps = { name: string; username?: string; p: Profile; pal: CardPalette; style: CSSProperties };

function Avatar({ src, name, size, pal, ring }: { src?: string; name: string; size: number; pal: CardPalette; ring?: boolean }) {
  const base: CSSProperties = { width: size, height: size };
  if (src) {
    return (
      <img
        src={src}
        alt={name}
        style={{ ...base, ...(ring ? { boxShadow: `0 0 0 2px ${pal.accent}` } : {}) }}
        className="rounded-full object-cover"
      />
    );
  }
  return (
    <div
      style={{ ...base, fontSize: size * 0.36, background: `${pal.accent}33`, color: pal.fg }}
      className="rounded-full flex items-center justify-center font-semibold"
    >
      {initials(name)}
    </div>
  );
}

/** A "label: value" line; renders nothing when empty. */
function Field({ label, value, pal }: { label: string; value?: string; pal: CardPalette }) {
  if (!value) return null;
  return (
    <div className="flex gap-2 text-sm">
      <span className="w-20 shrink-0" style={{ color: pal.muted }}>
        {label}
      </span>
      <span className="break-words min-w-0" style={{ color: pal.fg }}>
        {value}
      </span>
    </div>
  );
}

function ContactFields({ p, pal }: { p: Profile; pal: CardPalette }) {
  return (
    <>
      <Field label="Email" value={p.email} pal={pal} />
      <Field label="Phone" value={p.phone} pal={pal} />
      <Field label="Location" value={p.location} pal={pal} />
      <Field label="Website" value={p.website} pal={pal} />
    </>
  );
}

// ---------- Minimal ----------
function MinimalCard({ name, username, p, pal, style }: LayoutProps) {
  return (
    <div className="rounded-2xl p-5 flex items-start gap-4" style={style}>
      <Avatar src={p.avatar} name={name} size={64} pal={pal} />
      <div className="min-w-0 flex-1">
        <div className="text-lg font-semibold truncate" style={{ color: pal.fg }}>
          {name}
        </div>
        <div className="text-sm" style={{ color: pal.muted }}>
          {p.title || (username ? `@${username}` : "")}
          {p.pronouns ? ` · ${p.pronouns}` : ""}
        </div>
        {p.bio && (
          <p className="text-sm mt-2 whitespace-pre-wrap" style={{ color: pal.fg }}>
            {p.bio}
          </p>
        )}
      </div>
    </div>
  );
}

// ---------- Formal business card ----------
function FormalCard({ name, username, p, pal, style }: LayoutProps) {
  return (
    <div className="rounded-2xl overflow-hidden" style={style}>
      <div className="flex items-center gap-4 p-5" style={{ borderBottom: `1px solid ${pal.muted}33` }}>
        <Avatar src={p.avatar} name={name} size={72} pal={pal} ring />
        <div className="min-w-0">
          <div className="text-xl font-semibold truncate" style={{ color: pal.fg }}>
            {name}
          </div>
          {p.title && <div className="text-sm" style={{ color: pal.accent }}>{p.title}</div>}
          {p.organization && <div className="text-sm" style={{ color: pal.muted }}>{p.organization}</div>}
          {p.pronouns && <div className="text-xs mt-0.5" style={{ color: pal.muted }}>{p.pronouns}</div>}
        </div>
      </div>
      <div className="p-5 space-y-1.5">
        <ContactFields p={p} pal={pal} />
        {username && <Field label="Username" value={`@${username}`} pal={pal} />}
        {p.bio && (
          <p className="text-sm mt-3 whitespace-pre-wrap" style={{ color: pal.muted }}>
            {p.bio}
          </p>
        )}
      </div>
    </div>
  );
}

// ---------- Character sheet (D&D) ----------
function CharacterSheet({ name, username, p, pal, style }: LayoutProps) {
  const d = p.dnd ?? {};
  const stats = d.stats ?? {};
  return (
    <div className="rounded-2xl p-5 font-serif" style={style}>
      <div className="flex items-center gap-4">
        <Avatar src={p.avatar} name={name} size={72} pal={pal} ring />
        <div className="min-w-0 flex-1">
          <div className="text-xl font-bold tracking-wide truncate" style={{ color: pal.fg }}>
            {name}
          </div>
          <div className="text-sm italic" style={{ color: pal.accent }}>
            {[d.race, d.class, d.level ? `Level ${d.level}` : ""].filter(Boolean).join(" · ") || "Adventurer"}
          </div>
          {d.alignment && <div className="text-xs mt-0.5" style={{ color: pal.fg }}>Alignment: {d.alignment}</div>}
        </div>
      </div>

      <div className="grid grid-cols-6 gap-1.5 mt-4">
        {ABILITIES.map((k) => (
          <div key={k} className="rounded-lg text-center py-1.5" style={{ background: `${pal.accent}26`, border: `1px solid ${pal.accent}80` }}>
            <div className="text-[10px] uppercase tracking-wider" style={{ color: pal.muted }}>
              {k}
            </div>
            <div className="text-base font-bold" style={{ color: pal.fg }}>
              {stats[k] || "—"}
            </div>
          </div>
        ))}
      </div>

      {p.bio && (
        <div className="mt-4">
          <div className="text-[11px] uppercase tracking-widest" style={{ color: pal.muted }}>
            Backstory
          </div>
          <p className="text-sm mt-1 whitespace-pre-wrap" style={{ color: pal.fg }}>
            {p.bio}
          </p>
        </div>
      )}

      <div className="mt-4 pt-3 text-sm space-y-0.5" style={{ borderTop: `1px solid ${pal.accent}66`, color: pal.fg }}>
        {p.title && <div>{p.title}</div>}
        {p.email && <div>✉ {p.email}</div>}
        {p.phone && <div>☎ {p.phone}</div>}
        {p.location && <div>⌖ {p.location}</div>}
        {username && <div style={{ color: pal.muted }}>@{username}</div>}
      </div>
    </div>
  );
}

// ---------- Trading card ----------
function TradingCard({ name, username, p, pal, style }: LayoutProps) {
  const c = p.card ?? {};
  // Banner sits on the accent → pick a text color that reads on it (var accents
  // use the theme's designed on-primary text color).
  const bannerText = pal.accent.startsWith("var(") ? "var(--color-primary-text)" : readableText(pal.accent);
  return (
    <div className="rounded-2xl overflow-hidden shadow-lg max-w-xs" style={style}>
      <div className="px-4 py-2 flex items-center justify-between" style={{ background: pal.accent, color: bannerText }}>
        <span className="font-bold truncate">{name}</span>
        {c.rarity && (
          <span
            className="text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-full"
            style={{ background: "rgba(0,0,0,.22)", color: bannerText }}
          >
            {c.rarity}
          </span>
        )}
      </div>
      <div className="p-3">
        <div className="rounded-xl overflow-hidden aspect-square flex items-center justify-center mb-3" style={{ background: `${pal.muted}22` }}>
          <Avatar src={p.avatar} name={name} size={160} pal={pal} />
        </div>
        {c.tagline && (
          <p className="text-sm italic text-center mb-2" style={{ color: pal.muted }}>
            “{c.tagline}”
          </p>
        )}
        <div className="flex items-center justify-between rounded-lg px-3 py-2" style={{ background: `${pal.accent}22` }}>
          <span className="text-xs uppercase tracking-wide" style={{ color: pal.muted }}>
            {c.powerLabel || "Power"}
          </span>
          <span className="text-lg font-bold" style={{ color: pal.fg }}>
            {c.power || "∞"}
          </span>
        </div>
        <div className="mt-3 space-y-0.5 text-xs" style={{ color: pal.muted }}>
          {p.title && <div>{p.title}</div>}
          {p.organization && <div>{p.organization}</div>}
          {p.email && <div>✉ {p.email}</div>}
          {username && <div>@{username}</div>}
        </div>
      </div>
    </div>
  );
}
