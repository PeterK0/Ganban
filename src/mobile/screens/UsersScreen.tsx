import { useState } from "react";
import { confirmDialog } from '../../lib/confirm';
import type { User } from "../../types";
import { createUser, deleteUser, getUsers, updateUser } from "../../lib/api";
import { getMe } from "../../lib/daemon";
import { useNav } from "../nav";
import {
  Badge,
  Button,
  EmptyState,
  ErrorBanner,
  Fab,
  Field,
  ListRow,
  RefreshBtn,
  Screen,
  Sheet,
  Spinner,
  TextInput,
  Toggle,
  errMsg,
  useAsync,
} from "../ui";

/** People with an account on this host — the OWNER's management screen. There
 * is deliberately no "use this account" here: on a paired device, who you are
 * is decided by the pairing, not a pick-list. (The old "Use" button wrote a
 * local marker that changed labels and nothing else.) */
export default function UsersScreen() {
  const nav = useNav();
  const { data, loading, error, reload } = useAsync(() => getUsers(), []);
  const { data: me } = useAsync(() => getMe(), []);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<User | null>(null);
  const isOwner = !!me?.user.is_owner;

  const users = (data ?? []).slice().sort((a, b) => a.full_name.localeCompare(b.full_name));

  return (
    <Screen title="People on this host" onBack={nav.pop} right={<RefreshBtn onClick={reload} />}>
      {error && <ErrorBanner message={error} onRetry={reload} />}
      {loading && !data ? (
        <Spinner />
      ) : users.length === 0 ? (
        <EmptyState text="No users." />
      ) : (
        <div className="pb-24">
          {users.map((u) => (
            <ListRow
              key={u.id}
              title={u.full_name}
              subtitle={`@${u.username}${u.email ? " · " + u.email : ""}${u.is_active ? "" : " · inactive"}`}
              right={
                <span className="flex items-center gap-1.5">
                  {u.id === me?.user.id && <Badge className="bg-gilt-b text-gold">you</Badge>}
                  {u.is_owner && <Badge>owner</Badge>}
                </span>
              }
              onClick={() => (isOwner ? setEditing(u) : undefined)}
            />
          ))}
        </div>
      )}
      {isOwner && <Fab onClick={() => setCreating(true)} label="New user" />}
      {creating && (
        <UserForm
          onClose={() => setCreating(false)}
          onSaved={() => {
            setCreating(false);
            reload();
          }}
        />
      )}
      {editing && (
        <UserForm
          existing={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            reload();
          }}
          onDeleted={async () => {
            if (!await confirmDialog(`Delete user "${editing.full_name}"?`)) return;
            try {
              await deleteUser(editing.id);
              setEditing(null);
              reload();
            } catch (e) {
              alert(errMsg(e));
            }
          }}
        />
      )}
    </Screen>
  );
}

function UserForm({
  existing,
  onClose,
  onSaved,
  onDeleted,
}: {
  existing?: User;
  onClose: () => void;
  onSaved: () => void;
  onDeleted?: () => void;
}) {
  const [username, setUsername] = useState(existing?.username ?? "");
  const [fullName, setFullName] = useState(existing?.full_name ?? "");
  const [email, setEmail] = useState(existing?.email ?? "");
  const [isActive, setIsActive] = useState(existing?.is_active ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const valid = existing ? fullName.trim().length > 0 : username.trim().length > 0 && fullName.trim().length > 0;

  const save = async () => {
    if (!valid) return;
    setBusy(true);
    setError(null);
    try {
      if (existing) {
        await updateUser(existing.id, { full_name: fullName.trim(), email: email || undefined, is_active: isActive });
      } else {
        await createUser({ username: username.trim(), full_name: fullName.trim(), email: email || undefined });
      }
      onSaved();
    } catch (e) {
      setError(errMsg(e));
      setBusy(false);
    }
  };

  return (
    <Sheet
      title={existing ? "Edit user" : "New user"}
      onClose={onClose}
      footer={
        <>
          <Button full onClick={save} disabled={busy || !valid}>
            {busy ? "Saving…" : "Save"}
          </Button>
          {existing && onDeleted && (
            <Button full variant="danger" onClick={onDeleted}>
              Delete user
            </Button>
          )}
        </>
      }
    >
      {!existing && (
        <Field label="Username">
          <TextInput value={username} onChange={setUsername} autoFocus />
        </Field>
      )}
      <Field label="Full name">
        <TextInput value={fullName} onChange={setFullName} />
      </Field>
      <Field label="Email">
        <TextInput value={email} onChange={setEmail} inputMode="email" />
      </Field>
      {existing && <Toggle label="Active" value={isActive} onChange={setIsActive} />}
      {error && <p className="text-sm text-error">{error}</p>}
    </Sheet>
  );
}
