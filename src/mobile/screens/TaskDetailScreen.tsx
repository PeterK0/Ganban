import { useState } from "react";
import { confirmDialog } from '../../lib/confirm';
import type { Contact, Event, FileAttachment, Task, TaskStatus, User } from "../../types";
import { downloadSharedFile, uploadSharedFile } from "../../lib/daemon";
import ProfileCard from "../../components/ProfileCard";
import { parseProfile } from "../../lib/profile";
import {
  attachPastedImage,
  createComment,
  deleteComment,
  deleteFileAttachment,
  deleteTask,
  deleteTimeEntry,
  getActiveTimeEntry,
  getAreas,
  getContacts,
  getEvents,
  getFileAttachments,
  getTaskComments,
  getTaskContacts,
  getTaskEvents,
  getTimeEntries,
  getUsers,
  linkContactToTask,
  linkEventToTask,
  startTimeEntry,
  stopTimeEntry,
  toggleTaskPin,
  unlinkContactFromTask,
  unlinkEventFromTask,
  updateTaskStatus,
} from "../../lib/api";
import { fmtDayYear, parseWhen, formatDuration } from "../../lib/reportGenerator";
import MarkdownPreview from "../../components/MarkdownPreview";
import GifPicker from "../../components/GifPicker";
import { useNav } from "../nav";
import {
  Badge,
  Button,
  Dot,
  ErrorBanner,
  Field,
  ListRow,
  Screen,
  SectionHeader,
  Segmented,
  Sheet,
  Spinner,
  TASK_STATUSES,
  errMsg,
  priorityClasses,
  statusColor,
  useAsync,
} from "../ui";
import TaskForm from "../forms/TaskForm";

export default function TaskDetailScreen({ task: initial, onChanged }: { task: Task; onChanged: () => void }) {
  const nav = useNav();
  const [task, setTask] = useState(initial);
  const [editing, setEditing] = useState(false);
  const [actions, setActions] = useState(false);
  const [pickingContact, setPickingContact] = useState(false);
  const [pickingEvent, setPickingEvent] = useState(false);
  const [newComment, setNewComment] = useState("");
  const [uploading, setUploading] = useState(false);
  const [showGif, setShowGif] = useState(false);
  const [cardUser, setCardUser] = useState<User | null>(null);

  const appendToComment = (snippet: string) =>
    setNewComment((c) => `${c}${c && !c.endsWith("\n") ? "\n" : ""}${snippet}\n`);

  /** Upload the first image in a clipboard paste as a shared file and embed it. */
  const pasteImageIntoComment = async (clipboard: DataTransfer) => {
    const item = Array.from(clipboard.items).find((i) => i.type.startsWith("image/"));
    if (!item) return;
    const file = item.getAsFile();
    if (!file) return;
    setUploading(true);
    try {
      const att = await attachPastedImage(task.id, file);
      appendToComment(`![image](/files/${att.id})`);
      reload();
    } catch (err) {
      alert(errMsg(err));
    } finally {
      setUploading(false);
    }
  };

  const { data, loading, error, reload } = useAsync(
    () =>
      Promise.all([
        getTaskComments(task.id),
        getTimeEntries(task.id),
        getActiveTimeEntry(task.id),
        getTaskContacts(task.id),
        getAreas(task.project_id),
        getFileAttachments(task.id),
        getUsers(),
        getTaskEvents(task.id),
      ]),
    [task.id]
  );

  const comments = data?.[0] ?? [];
  const entries = data?.[1] ?? [];
  const activeEntry = data?.[2] ?? null;
  const contacts = data?.[3] ?? [];
  const areas = data?.[4] ?? [];
  const attachments = data?.[5] ?? [];
  const users = data?.[6] ?? [];
  const events = data?.[7] ?? [];
  const userName = (id?: number | null) => (id == null ? null : users.find((u) => u.id === id)?.full_name ?? null);
  const totalSeconds = entries.reduce((sum, e) => sum + (e.duration ?? 0), 0);

  const refreshAll = () => {
    reload();
    onChanged();
  };

  const changeStatus = async (status: TaskStatus) => {
    try {
      setTask(await updateTaskStatus(task.id, status));
      onChanged();
    } catch (e) {
      alert(errMsg(e));
    }
  };

  const toggleTimer = async () => {
    try {
      if (activeEntry) await stopTimeEntry(activeEntry.id);
      else await startTimeEntry(task.id);
      reload();
    } catch (e) {
      alert(errMsg(e));
    }
  };

  const onPickFile = async (file: File) => {
    setUploading(true);
    try {
      await uploadSharedFile(task.id, file);
      reload();
    } catch (e) {
      alert(errMsg(e));
    } finally {
      setUploading(false);
    }
  };

  const downloadShared = async (f: FileAttachment) => {
    try {
      await downloadSharedFile(f.id, f.file_name);
    } catch (e) {
      alert(errMsg(e));
    }
  };

  const addComment = async () => {
    if (!newComment.trim()) return;
    try {
      await createComment({ task_id: task.id, content: newComment.trim() });
      setNewComment("");
      reload();
    } catch (e) {
      alert(errMsg(e));
    }
  };

  const meta: { label: string; value: string }[] = [];
  if (task.area_id) meta.push({ label: "Area", value: areas.find((a) => a.id === task.area_id)?.name ?? "—" });
  if (task.deadline) meta.push({ label: "Deadline", value: fmtDayYear(parseWhen(task.deadline)) });
  if (task.cost != null) meta.push({ label: "Cost", value: `${task.cost}${task.currency ? " " + task.currency : ""}` });
  if (task.prefix) meta.push({ label: "Prefix", value: task.prefix });

  return (
    <Screen
      title={task.title}
      onBack={nav.pop}
      right={
        <button onClick={() => setActions(true)} className="g-iconbtn w-11 h-11 text-xl active:bg-surface-0" aria-label="Actions">
          ⋯
        </button>
      }
    >
      {error && <ErrorBanner message={error} onRetry={reload} />}

      <div className="p-4 space-y-4">
        <div className="flex items-center gap-2">
          <Badge className={priorityClasses(task.priority)}>{task.priority}</Badge>
          {task.pinned && <Badge className="bg-gilt-b text-gold">★ Pinned</Badge>}
        </div>

        <Field label="Status">
          <Segmented options={TASK_STATUSES} value={task.status} onChange={changeStatus} columns={2} />
        </Field>

        {task.description && (
          <div>
            <div className="g-flbl">Description</div>
            <div className="g-inset max-w-[72ch]">
              <MarkdownPreview content={task.description} />
            </div>
          </div>
        )}

        {meta.length > 0 && (
          <div className="grid grid-cols-2 gap-2 min-[700px]:grid-cols-4">
            {meta.map((m) => (
              <div key={m.label} className="g-plain min-w-0 px-3 pt-2.5 pb-2">
                <div className="g-flbl mb-1">{m.label}</div>
                <div className="text-sm truncate">{m.value}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Time tracking */}
      <SectionHeader right={<span className="text-sm gm-fg2 tabular-nums">{formatDuration(totalSeconds)}</span>}>
        Time tracking
      </SectionHeader>
      <div className="px-4 pb-2">
        <Button full variant={activeEntry ? "danger" : "surface"} onClick={toggleTimer}>
          {activeEntry ? "■ Stop timer" : "▶ Start timer"}
        </Button>
      </div>
      {entries.map((e) => (
        <ListRow
          key={e.id}
          title={e.duration != null ? formatDuration(e.duration) : "Running…"}
          subtitle={new Date(e.start_time).toLocaleString()}
          onDelete={async () => {
            if (!await confirmDialog("Delete this time entry?")) return;
            try {
              await deleteTimeEntry(e.id);
              reload();
            } catch (err) {
              alert(errMsg(err));
            }
          }}
        />
      ))}

      {/* Comments */}
      <SectionHeader>Comments</SectionHeader>
      {comments.map((c) => (
        <div key={c.id} className="flex items-start gap-2 pl-4 pr-1 py-3 border-b border-gilt-b">
          <div className="min-w-0 flex-1">
            <MarkdownPreview content={c.content} />
            <div className="text-xs gm-mut mt-1">
              {(() => {
                const u = c.user_id != null ? users.find((x) => x.id === c.user_id) : undefined;
                return u ? (
                  <>
                    <button onClick={() => setCardUser(u)} className="text-info font-medium min-h-[32px] active:opacity-60">
                      {u.full_name}
                    </button>
                    {" · "}
                  </>
                ) : null;
              })()}
              {new Date(c.created_at).toLocaleString()}
            </div>
          </div>
          <button
            onClick={async () => {
              if (!await confirmDialog("Delete comment?")) return;
              try {
                await deleteComment(c.id);
                reload();
              } catch (err) {
                alert(errMsg(err));
              }
            }}
            className="text-error min-w-[44px] min-h-[44px]"
            aria-label="Delete comment"
          >
            ✕
          </button>
        </div>
      ))}
      <div className="flex items-end gap-2 p-4">
        <div className="flex-1 min-w-0">
        <textarea
          value={newComment}
          onChange={(e) => setNewComment(e.target.value)}
          onPaste={(e) => {
            if (Array.from(e.clipboardData.items).some((i) => i.type.startsWith("image/"))) {
              e.preventDefault();
              pasteImageIntoComment(e.clipboardData);
            }
          }}
          rows={1}
          placeholder={uploading ? "Uploading image…" : "Add a comment… (paste an image, or add a GIF)"}
          className="g-field gm-field gm-composer"
        />
        </div>
        <button
          onClick={() => setShowGif(true)}
          className="g-btn g-btn-ghost shrink-0 min-h-[44px] px-3 text-sm"
          aria-label="Add a GIF"
        >
          GIF
        </button>
        <Button onClick={addComment} disabled={!newComment.trim()}>
          Send
        </Button>
      </div>
      {showGif && (
        <GifPicker
          onClose={() => setShowGif(false)}
          onPick={(url) => {
            appendToComment(`![gif](${url})`);
            setShowGif(false);
          }}
        />
      )}
      {cardUser && (
        <Sheet title={cardUser.full_name} onClose={() => setCardUser(null)}>
          <div className="max-h-[70vh] overflow-y-auto">
            <ProfileCard name={cardUser.full_name} username={cardUser.username} profile={parseProfile(cardUser.profile_json)} />
          </div>
        </Sheet>
      )}

      {/* Linked contacts */}
      <SectionHeader right={<button onClick={() => setPickingContact(true)} className="g-lnk min-h-[44px] px-2 text-sm">+ Link</button>}>
        Contacts
      </SectionHeader>
      {contacts.length === 0 ? (
        <p className="px-4 py-2 text-sm gm-mut italic">No linked contacts</p>
      ) : (
        contacts.map((c) => (
          <ListRow
            key={c.id}
            title={c.full_name}
            subtitle={c.occupation || undefined}
            onDelete={async () => {
              try {
                await unlinkContactFromTask(task.id, c.id);
                reload();
              } catch (err) {
                alert(errMsg(err));
              }
            }}
            deleteLabel="Unlink"
          />
        ))
      )}

      {/* Linked events */}
      <SectionHeader right={<button onClick={() => setPickingEvent(true)} className="g-lnk min-h-[44px] px-2 text-sm">+ Link</button>}>
        Events
      </SectionHeader>
      {events.length === 0 ? (
        <p className="px-4 py-2 text-sm gm-mut italic">No linked events</p>
      ) : (
        events.map((e) => (
          <ListRow
            key={e.id}
            title={e.title}
            subtitle={new Date(e.event_date).toLocaleDateString()}
            onDelete={async () => {
              try {
                await unlinkEventFromTask(e.id, task.id);
                reload();
              } catch (err) {
                alert(errMsg(err));
              }
            }}
            deleteLabel="Unlink"
          />
        ))
      )}

      {/* Files: upload a shared file (stored in the project allocation), or
          download one. Local-only files live on the desktop and can't be opened here. */}
      <SectionHeader
        right={
          <label className={`g-lnk min-h-[44px] px-2 text-sm cursor-pointer ${uploading ? "opacity-50" : ""}`}>
            {uploading ? "Uploading…" : "+ Upload"}
            <input
              type="file"
              className="hidden"
              disabled={uploading}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) onPickFile(f);
                e.currentTarget.value = "";
              }}
            />
          </label>
        }
      >
        Files
      </SectionHeader>
      {attachments.length === 0 ? (
        <p className="px-4 py-2 text-sm gm-mut italic">No files yet. Tap “+ Upload” to add one.</p>
      ) : (
        attachments.map((f) => (
          <ListRow
            key={f.id}
            title={f.file_name}
            subtitle={`${userName(f.uploaded_by) ? userName(f.uploaded_by) + " · " : ""}${
              f.is_shared ? "shared · tap to download" : "local (open on desktop)"
            }`}
            right={
              f.is_shared ? (
                <span className="text-gold text-lg">↓</span>
              ) : !f.is_valid ? (
                <Badge className="g-tag-red">missing</Badge>
              ) : undefined
            }
            onClick={f.is_shared ? () => downloadShared(f) : undefined}
            onDelete={async () => {
              if (!await confirmDialog(`Remove attachment "${f.file_name}"?`)) return;
              try {
                await deleteFileAttachment(f.id);
                reload();
              } catch (err) {
                alert(errMsg(err));
              }
            }}
          />
        ))
      )}

      <div className="h-6" />
      {loading && !data && <Spinner />}

      {editing && (
        <TaskForm
          projectId={task.project_id}
          areas={areas}
          existing={task}
          onClose={() => setEditing(false)}
          onSaved={(updated) => {
            setTask(updated);
            setEditing(false);
            refreshAll();
          }}
        />
      )}

      {pickingContact && (
        <ContactPicker
          linkedIds={contacts.map((c) => c.id)}
          onClose={() => setPickingContact(false)}
          onPick={async (contact) => {
            try {
              await linkContactToTask(task.id, contact.id);
              setPickingContact(false);
              reload();
            } catch (err) {
              alert(errMsg(err));
            }
          }}
        />
      )}

      {pickingEvent && (
        <EventPicker
          linkedIds={events.map((e) => e.id)}
          onClose={() => setPickingEvent(false)}
          onPick={async (ev) => {
            try {
              await linkEventToTask(ev.id, task.id);
              setPickingEvent(false);
              reload();
            } catch (err) {
              alert(errMsg(err));
            }
          }}
        />
      )}

      {actions && (
        <Sheet title="Task" onClose={() => setActions(false)}>
          <Button full variant="surface" onClick={() => { setActions(false); setEditing(true); }}>
            Edit task
          </Button>
          <Button
            full
            variant="surface"
            onClick={async () => {
              setActions(false);
              try {
                setTask(await toggleTaskPin(task.id, !task.pinned));
                onChanged();
              } catch (e) {
                alert(errMsg(e));
              }
            }}
          >
            {task.pinned ? "Unpin task" : "Pin task"}
          </Button>
          <Button
            full
            variant="danger"
            onClick={async () => {
              if (!await confirmDialog(`Move "${task.title}" to the bin?`)) return;
              setActions(false);
              try {
                await deleteTask(task.id);
                onChanged();
                nav.pop();
              } catch (e) {
                alert(errMsg(e));
              }
            }}
          >
            Delete (to bin)
          </Button>
        </Sheet>
      )}
    </Screen>
  );
}

function ContactPicker({
  linkedIds,
  onClose,
  onPick,
}: {
  linkedIds: number[];
  onClose: () => void;
  onPick: (c: Contact) => void;
}) {
  const { data, loading, error } = useAsync(() => getContacts(false), []);
  const available = (data ?? []).filter((c) => !linkedIds.includes(c.id));

  return (
    <Sheet title="Link a contact" onClose={onClose}>
      {error && <p className="text-sm text-error">{error}</p>}
      {loading && !data ? (
        <Spinner />
      ) : available.length === 0 ? (
        <p className="text-sm gm-mut italic">No more contacts to link.</p>
      ) : (
        <div className="-mx-5">
          {available.map((c) => (
            <ListRow
              key={c.id}
              title={c.full_name}
              subtitle={c.occupation || undefined}
              left={<Dot className={statusColor("")} />}
              onClick={() => onPick(c)}
            />
          ))}
        </div>
      )}
    </Sheet>
  );
}

function EventPicker({
  linkedIds,
  onClose,
  onPick,
}: {
  linkedIds: number[];
  onClose: () => void;
  onPick: (e: Event) => void;
}) {
  const { data, loading, error } = useAsync(() => getEvents(undefined, undefined, false), []);
  const available = (data ?? [])
    .filter((e) => !linkedIds.includes(e.id))
    .sort((a, b) => new Date(b.event_date).getTime() - new Date(a.event_date).getTime());

  return (
    <Sheet title="Link an event" onClose={onClose}>
      {error && <p className="text-sm text-error">{error}</p>}
      {loading && !data ? (
        <Spinner />
      ) : available.length === 0 ? (
        <p className="text-sm gm-mut italic">No more events to link.</p>
      ) : (
        <div className="-mx-5">
          {available.map((e) => (
            <ListRow
              key={e.id}
              title={e.title}
              subtitle={new Date(e.event_date).toLocaleDateString()}
              onClick={() => onPick(e)}
            />
          ))}
        </div>
      )}
    </Sheet>
  );
}
