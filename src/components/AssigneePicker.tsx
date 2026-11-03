// Searchable "+ Assign…" picker: project MEMBERS first, then CONTACTS from the
// address book (people responsible who aren't Ganban users). One text field,
// one list, keyboard-driven — a <select> couldn't search and couldn't mix the
// two kinds honestly.
//
// Contacts already linked to a member's user account are folded into that
// member (assigning the member is what notifies and dispatches); the core
// refuses such contacts anyway, so the picker never offers them.

import { useEffect, useMemo, useRef, useState } from 'react';
import { getContacts } from '../lib/api';
import type { Contact, ProjectMemberOverview } from '../types';

type Option =
  | { kind: 'user'; id: number; label: string; sub?: string }
  | { kind: 'contact'; id: number; label: string; sub?: string };

interface Props {
  members: ProjectMemberOverview[];
  /** Keys already assigned (`user:<id>` / `contact:<id>`) — hidden from the list. */
  excludeKeys: Set<string>;
  onPickUser: (userId: number) => void | Promise<void>;
  onPickContact: (contactId: number) => void | Promise<void>;
}

function parseList(json?: string): string[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

export default function AssigneePicker({ members, excludeKeys, onPickUser, onPickContact }: Props) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [contacts, setContacts] = useState<Contact[] | null>(null); // null = not loaded yet
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [cursor, setCursor] = useState(0);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Contacts load on first open — the address book is global and can be long;
  // the editor shouldn't pay for it until someone reaches for the picker.
  useEffect(() => {
    if (!open || contacts !== null) return;
    getContacts(false)
      .then(setContacts)
      .catch((e) => {
        setContacts([]);
        setLoadErr(e instanceof Error ? e.message : String(e));
      });
  }, [open, contacts]);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', away);
    return () => window.removeEventListener('mousedown', away);
  }, [open]);

  const options = useMemo<Option[]>(() => {
    const memberUserIds = new Set(members.map((m) => m.user_id));
    const users: Option[] = members
      .filter((m) => !excludeKeys.has(`user:${m.user_id}`))
      .map((m) => ({ kind: 'user', id: m.user_id, label: m.display_name || m.username, sub: m.role }));
    const people: Option[] = (contacts ?? [])
      .filter((c) => !excludeKeys.has(`contact:${c.id}`))
      // linked to a member → they're in the members list already
      .filter((c) => !(c.user_id != null && memberUserIds.has(c.user_id)))
      .map((c) => ({
        kind: 'contact',
        id: c.id,
        label: c.full_name,
        sub: [c.occupation, parseList(c.emails)[0]].filter(Boolean).join(' · ') || undefined,
      }));
    const needle = q.trim().toLowerCase();
    const hit = (o: Option) => !needle || o.label.toLowerCase().includes(needle) || (o.sub ?? '').toLowerCase().includes(needle);
    return [...users.filter(hit), ...people.filter(hit)];
  }, [members, contacts, excludeKeys, q]);

  useEffect(() => setCursor(0), [q, open]);

  const pick = async (o: Option) => {
    setOpen(false);
    setQ('');
    if (o.kind === 'user') await onPickUser(o.id);
    else await onPickContact(o.id);
  };

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      setOpen(false);
      return;
    }
    if (!open) setOpen(true);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setCursor((c) => Math.min(c + 1, Math.max(options.length - 1, 0)));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setCursor((c) => Math.max(c - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const o = options[cursor];
      if (o) void pick(o);
    }
  };

  const firstContactIdx = options.findIndex((o) => o.kind === 'contact');

  return (
    <div ref={rootRef} className="relative">
      <input
        ref={inputRef}
        type="text"
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKey}
        placeholder="+ Assign a member or contact…"
        className="g-field g-field-sm"
        aria-expanded={open}
        aria-autocomplete="list"
      />
      {open && (
        <div className="absolute left-0 right-0 top-full mt-1 z-30 max-h-64 overflow-y-auto bg-base border border-gilt-a rounded shadow-lg">
          {options.length === 0 && (
            <div className="px-3 py-2 text-xs text-subtext-0">
              {contacts === null ? 'Loading contacts…' : q ? `Nobody matches “${q}”` : 'Everyone is already assigned.'}
              {loadErr && <div className="text-error mt-1">Contacts unavailable: {loadErr}</div>}
            </div>
          )}
          {options.map((o, i) => (
            <div key={`${o.kind}:${o.id}`}>
              {i === 0 && o.kind === 'user' && <div className="g-flbl px-3 pt-2.5 !mb-1">Members</div>}
              {i === firstContactIdx && <div className="g-flbl px-3 pt-2.5 !mb-1 border-t border-gilt-b">Contacts</div>}
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()} // keep input focus; the click handles it
                onClick={() => void pick(o)}
                onMouseEnter={() => setCursor(i)}
                className={`w-full text-left px-3 min-h-[36px] flex items-center gap-2 text-sm ${i === cursor ? 'bg-gilt-b' : ''}`}
              >
                <span
                  className={`g-av ${o.kind === 'user' ? '' : '!text-subtext-1 !border-surface-1'}`}
                  style={{ width: 22, height: 22, fontSize: 9 }}
                  aria-hidden="true"
                >
                  {o.label.slice(0, 2).toUpperCase()}
                </span>
                <span className="truncate text-text">{o.label}</span>
                {o.sub && <span className="truncate text-[11px] text-subtext-0 ml-auto">{o.sub}</span>}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
