import { useState } from "react";
import { confirmDialog } from '../../lib/confirm';
import type { Contact } from "../../types";
import {
  createContact,
  deleteContact,
  getContactTasks,
  getContacts,
  updateContact,
} from "../../lib/api";
import { useNav } from "../nav";
import { StatusMark } from "../../components/comments/TaskTagPicker";
import {
  Button,
  EmptyState,
  ErrorBanner,
  Fab,
  Field,
  ListRow,
  RefreshBtn,
  Screen,
  SectionHeader,
  Sheet,
  Spinner,
  TextArea,
  TextInput,
  dateInputToIso,
  errMsg,
  isoToDateInput,
  useAsync,
} from "../ui";

function parseList(s?: string | null): string[] {
  if (!s) return [];
  try {
    const arr = JSON.parse(s);
    return Array.isArray(arr) ? arr.map(String) : [String(s)];
  } catch {
    return s.split(",").map((x) => x.trim()).filter(Boolean);
  }
}
function serializeList(s: string): string | undefined {
  const arr = s.split(",").map((x) => x.trim()).filter(Boolean);
  return arr.length ? JSON.stringify(arr) : undefined;
}

export default function ContactsScreen() {
  const nav = useNav();
  const { data, loading, error, reload } = useAsync(() => getContacts(false), []);
  const [creating, setCreating] = useState(false);

  const contacts = (data ?? []).slice().sort((a, b) => a.full_name.localeCompare(b.full_name));

  return (
    <Screen title="Contacts" right={<RefreshBtn onClick={reload} />}>
      {error && <ErrorBanner message={error} onRetry={reload} />}
      {loading && !data ? (
        <Spinner />
      ) : contacts.length === 0 ? (
        <EmptyState text="No contacts. Tap + to add one." />
      ) : (
        <div className="pb-24 min-[700px]:grid min-[700px]:grid-cols-2 min-[700px]:gap-x-4">
          {contacts.map((c) => (
            <ListRow
              key={c.id}
              left={<span className="g-av w-9 h-9" aria-hidden="true">{initials(c.full_name)}</span>}
              title={c.full_name}
              subtitle={c.occupation || parseList(c.emails)[0] || undefined}
              onClick={() => nav.push(<ContactDetailScreen contact={c} onChanged={reload} />)}
            />
          ))}
        </div>
      )}
      <Fab onClick={() => setCreating(true)} label="New contact" />
      {creating && (
        <ContactForm
          onClose={() => setCreating(false)}
          onSaved={() => {
            setCreating(false);
            reload();
          }}
        />
      )}
    </Screen>
  );
}

function ContactDetailScreen({ contact: initial, onChanged }: { contact: Contact; onChanged: () => void }) {
  const nav = useNav();
  const [contact, setContact] = useState(initial);
  const [editing, setEditing] = useState(false);
  const { data: tasks } = useAsync(() => getContactTasks(contact.id), [contact.id]);

  const phones = parseList(contact.phone_numbers);
  const emails = parseList(contact.emails);

  return (
    <Screen
      title={contact.full_name}
      onBack={nav.pop}
      subtitle={contact.occupation || undefined}
      right={
        <button onClick={() => setEditing(true)} className="g-lnk min-h-[44px] px-3 text-sm">
          Edit
        </button>
      }
    >
      <div className="m-4 px-4 py-3.5 g-card g-corners space-y-3 empty:hidden">
        {phones.length > 0 && <InfoRow label="Phone" values={phones} hrefPrefix="tel:" />}
        {emails.length > 0 && <InfoRow label="Email" values={emails} hrefPrefix="mailto:" />}
        {contact.birthday && (
          <div>
            <div className="g-flbl mb-0.5">Birthday</div>
            <div>{new Date(contact.birthday).toLocaleDateString()}</div>
          </div>
        )}
        {contact.notes && (
          <div>
            <div className="g-flbl mb-0.5">Notes</div>
            <p className="whitespace-pre-wrap max-w-[72ch]">{contact.notes}</p>
          </div>
        )}
      </div>

      <SectionHeader>Linked tasks</SectionHeader>
      {!tasks || tasks.length === 0 ? (
        <p className="px-4 py-2 text-sm gm-mut italic">No linked tasks</p>
      ) : (
        tasks.map((t) => <ListRow key={t.id} title={t.title} subtitle={t.status} left={<StatusMark status={t.status} size={12} />} />)
      )}

      <div className="p-4">
        <Button
          full
          variant="danger"
          onClick={async () => {
            if (!await confirmDialog(`Move "${contact.full_name}" to the bin?`)) return;
            try {
              await deleteContact(contact.id);
              onChanged();
              nav.pop();
            } catch (e) {
              alert(errMsg(e));
            }
          }}
        >
          Delete (to bin)
        </Button>
      </div>

      {editing && (
        <ContactForm
          existing={contact}
          onClose={() => setEditing(false)}
          onSaved={(c) => {
            setContact(c);
            setEditing(false);
            onChanged();
          }}
        />
      )}
    </Screen>
  );
}

function InfoRow({ label, values, hrefPrefix }: { label: string; values: string[]; hrefPrefix: string }) {
  return (
    <div>
      <div className="g-flbl mb-0.5">{label}</div>
      <div className="flex flex-col">
        {values.map((v, i) => (
          <a key={i} href={`${hrefPrefix}${v}`} className="text-info min-h-[36px] flex items-center break-all">
            {v}
          </a>
        ))}
      </div>
    </div>
  );
}

function ContactForm({
  existing,
  onClose,
  onSaved,
}: {
  existing?: Contact;
  onClose: () => void;
  onSaved: (c: Contact) => void;
}) {
  const [fullName, setFullName] = useState(existing?.full_name ?? "");
  const [occupation, setOccupation] = useState(existing?.occupation ?? "");
  const [phones, setPhones] = useState(parseList(existing?.phone_numbers).join(", "));
  const [emails, setEmails] = useState(parseList(existing?.emails).join(", "));
  const [birthday, setBirthday] = useState(isoToDateInput(existing?.birthday));
  const [notes, setNotes] = useState(existing?.notes ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    if (!fullName.trim()) return;
    setBusy(true);
    setError(null);
    const birthdayIso = dateInputToIso(birthday);
    try {
      const payload = {
        full_name: fullName.trim(),
        occupation: occupation || undefined,
        phone_numbers: serializeList(phones),
        emails: serializeList(emails),
        birthday: birthdayIso,
        notes: notes || undefined,
      };
      const c = existing ? await updateContact(existing.id, payload) : await createContact(payload);
      onSaved(c);
    } catch (e) {
      setError(errMsg(e));
      setBusy(false);
    }
  };

  return (
    <Sheet
      title={existing ? "Edit contact" : "New contact"}
      onClose={onClose}
      footer={
        <Button full onClick={save} disabled={busy || !fullName.trim()}>
          {busy ? "Saving…" : "Save"}
        </Button>
      }
    >
      <Field label="Full name">
        <TextInput value={fullName} onChange={setFullName} autoFocus />
      </Field>
      <Field label="Occupation">
        <TextInput value={occupation} onChange={setOccupation} />
      </Field>
      <Field label="Phone numbers (comma-separated)">
        <TextInput value={phones} onChange={setPhones} inputMode="tel" />
      </Field>
      <Field label="Emails (comma-separated)">
        <TextInput value={emails} onChange={setEmails} inputMode="email" />
      </Field>
      <Field label="Birthday">
        <TextInput value={birthday} onChange={setBirthday} type="date" />
      </Field>
      <Field label="Notes">
        <TextArea value={notes} onChange={setNotes} rows={3} />
      </Field>
      {error && <p className="text-sm text-error">{error}</p>}
    </Sheet>
  );
}

/** Up to two initials for a contact's avatar. */
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase() || "·";
}
