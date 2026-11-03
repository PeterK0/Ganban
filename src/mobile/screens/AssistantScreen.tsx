import { useEffect, useRef, useState } from "react";
import { confirmDialog } from '../../lib/confirm';
import type { Project } from "../../types";
import { getProjects } from "../../lib/api";
import {
  DaemonError,
  streamChat,
  executeProposal,
  rejectProposal,
  listChats,
  getChatMessages,
  setChatPublic,
  listProfiles,
  upsertProfile,
  deleteProfile,
  setActiveProfile,
  getModelInfo,
  parseModelMeta,
  listOllamaModels,
  listIndexJobs,
  cancelIndexJob,
  reindexProject,
  type Chat,
  type ChatSource,
  type ModelProfile,
  type ModelMeta,
  type IndexJob,
  type ToolProposal,
  type ProposalDetails,
} from "../../lib/daemon";
import { useNav } from "../nav";
import { projectColorClass, projectInitial } from "../../lib/projectColor";
import {
  Badge,
  Button,
  Chevron,
  EmptyState,
  ErrorBanner,
  Fab,
  Field,
  RefreshBtn,
  Screen,
  Segmented,
  Select,
  Sheet,
  Spinner,
  TextArea,
  TextInput,
  errMsg,
  useAsync,
} from "../ui";

/** The proposals SSE payload may carry a field-level before/after snapshot
 * (same shape as PendingProposal.details) on top of the declared type. */
type ProposalPayload = ToolProposal & { details?: ProposalDetails };

interface Msg {
  role: "user" | "assistant";
  content: string;
  sources?: ChatSource[];
  /** Read tools the agent invoked this turn (when Tools mode was on). */
  tools?: string[];
  /** Write actions the agent proposed this turn (await approval). */
  proposals?: ProposalPayload[];
}

function parseSources(json: string | null | undefined): ChatSource[] | undefined {
  if (!json) return undefined;
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

function parseTools(json: string | null | undefined): string[] | undefined {
  if (!json) return undefined;
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) && v.length ? v.filter((t): t is string => typeof t === "string") : undefined;
  } catch {
    return undefined;
  }
}

const sourceLabel = (s: ChatSource): string => {
  if (s.label) return s.label;
  if (s.source?.startsWith("task-")) return "Task";
  if (s.source?.startsWith("event-")) return "Event";
  if (s.source?.startsWith("area-")) return "Area";
  if (s.source === "project.md") return "Project";
  return "File";
};

// ── Assistant: a tabbed hub (Chats · Indexing · Models) ─────────────────────

type AssistantTab = "Chats" | "Indexing" | "Models";

/** Top-level Assistant. Chats = projects-as-folders; Indexing = the ragrat
 * queue; Models = set up assistants (owner-only). */
export default function AssistantScreen() {
  const nav = useNav();
  const [tab, setTab] = useState<AssistantTab>("Chats");
  return (
    <Screen title="Assistant" onBack={nav.pop}>
      <div className="px-4 pt-3">
        <Segmented options={["Chats", "Indexing", "Models"] as const} value={tab} onChange={setTab} columns={3} />
      </div>
      {tab === "Chats" && <ChatsTab />}
      {tab === "Indexing" && <IndexingTab />}
      {tab === "Models" && <ModelsTab />}
    </Screen>
  );
}

/** Chats tab: pick a project to chat about (each is a folder of threads). */
function ChatsTab() {
  const nav = useNav();
  const { data, loading, error, reload } = useAsync(() => getProjects(), []);
  const projects = (data ?? []).filter((p) => !p.archived);

  return (
    <>
      {error && <ErrorBanner message={error} onRetry={reload} />}
      {loading && !data ? (
        <Spinner />
      ) : projects.length === 0 ? (
        <EmptyState text="No projects yet. The assistant answers questions grounded in a project's tasks, events, notes and files." />
      ) : (
        <div className="pb-24">
          <p className="px-4 py-3 text-sm gm-mut">
            Chat with an AI grounded in a project's tasks, events, notes &amp; files.
          </p>
          {projects.map((p) => (
            <button
              key={p.id}
              onClick={() => nav.push(<ProjectChatsScreen project={p} />)}
              className="gm-row"
            >
              <span className={`g-tile ${projectColorClass(p)}`} aria-hidden="true">{projectInitial(p.name)}</span>
              <span className="flex-1 min-w-0 truncate text-[15px] font-medium">{p.name}</span>
              <Chevron />
            </button>
          ))}
        </div>
      )}
    </>
  );
}

// ── Indexing tab: the ragrat queue ──────────────────────────────────────────

const JOB_BADGE: Record<string, string> = {
  running: "bg-gilt-b text-gold",
  queued: "",
  succeeded: "g-tag-ok",
  failed: "g-tag-red",
  cancelled: "gm-mut",
};
const JOB_RANK: Record<string, number> = { running: 0, queued: 1, succeeded: 2, failed: 2, cancelled: 3 };

function jobWhen(j: IndexJob): string {
  const t = j.finished_at || j.started_at || j.created_at;
  if (!t) return "";
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString();
}

function IndexingTab() {
  const [jobs, setJobs] = useState<IndexJob[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [disabled, setDisabled] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getProjects().then(setProjects).catch(() => {});
  }, []);
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const js = await listIndexJobs();
        if (alive) {
          setJobs(js);
          setErr(null);
          setDisabled(false);
        }
      } catch (e) {
        if (!alive) return;
        if (e instanceof DaemonError && e.status === 404) setDisabled(true);
        else setErr(errMsg(e));
      } finally {
        if (alive) setLoading(false);
      }
    };
    void tick();
    const id = setInterval(tick, 3000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const name = (id?: number | null) =>
    id == null ? "Unknown project" : projects.find((p) => p.id === id)?.name ?? `Project ${id}`;
  const sorted = [...jobs].sort(
    (a, b) =>
      (JOB_RANK[a.status] ?? 9) - (JOB_RANK[b.status] ?? 9) ||
      new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime()
  );

  if (disabled) {
    return <EmptyState text="Indexing isn't enabled. Set up ragrat in Settings → AI Engines on the host." />;
  }
  return (
    <div className="pb-24">
      {err && <ErrorBanner message={err} />}
      {loading && jobs.length === 0 ? (
        <Spinner />
      ) : sorted.length === 0 ? (
        <EmptyState text="Nothing indexed yet. Use “Update AI” on a project's Files screen to queue one." />
      ) : (
        sorted.map((j) => (
          <div key={j.id} className="flex items-center gap-3 pl-4 pr-2 py-2 min-h-[56px] border-b border-gilt-b">
            {j.status === "running" && (
              <span className="shrink-0 inline-block w-3.5 h-3.5 border-2 border-gold border-t-transparent rounded-full animate-spin" />
            )}
            <div className="flex-1 min-w-0">
              <div className="text-[15px] truncate">{name(j.project_id)}</div>
              <div className="text-xs gm-mut truncate">
                {jobWhen(j)}
                {j.error ? ` · ${j.error}` : ""}
              </div>
            </div>
            <Badge className={JOB_BADGE[j.status] ?? "gm-mut"}>{j.status}</Badge>
            {j.status === "queued" && (
              <button
                onClick={() => cancelIndexJob(j.id).catch((e) => setErr(errMsg(e)))}
                className="text-xs gm-mut active:opacity-60 min-h-[44px] px-2"
              >
                Cancel
              </button>
            )}
            {(j.status === "failed" || j.status === "cancelled") && j.project_id != null && (
              <button
                onClick={() => reindexProject(j.project_id!).catch((e) => setErr(errMsg(e)))}
                className="g-lnk min-h-[44px] px-2 text-xs"
              >
                Retry
              </button>
            )}
          </div>
        ))
      )}
    </div>
  );
}

// ── Models tab: set up assistants (owner-only) ──────────────────────────────

function Avatar({ avatar, name, size = 40 }: { avatar?: string | null; name: string; size?: number }) {
  if (avatar) {
    return <img src={avatar} alt="" className="rounded-full object-cover shrink-0" style={{ width: size, height: size }} />;
  }
  return (
    <div
      className="g-av"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.4) }}
    >
      {name.trim().slice(0, 1).toUpperCase() || "🤖"}
    </div>
  );
}

function ModelsTab() {
  const [profiles, setProfiles] = useState<ModelProfile[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [notOwner, setNotOwner] = useState(false);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<ModelProfile | null | undefined>(undefined); // undefined=closed, null=new
  const [err, setErr] = useState<string | null>(null);

  const load = async () => {
    try {
      const r = await listProfiles();
      setProfiles(r.profiles);
      setActiveId(r.active_id);
    } catch (e) {
      if (e instanceof DaemonError && (e.status === 401 || e.status === 403)) setNotOwner(true);
      else setErr(errMsg(e));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void load();
    listOllamaModels().then(setModels).catch(() => {});
  }, []);

  if (notOwner) {
    return <EmptyState text="Setting up assistants is done on the host. Ask the owner, or open Ganban on the host machine." />;
  }
  return (
    <div className="pb-24">
      {err && <ErrorBanner message={err} />}
      <p className="px-4 py-3 text-sm gm-mut">
        A personality is a model + system prompt + parameters. The active one answers in chats.
      </p>
      {loading && profiles.length === 0 ? (
        <Spinner />
      ) : (
        profiles.map((p) => (
          <div key={p.id} className="flex items-center gap-3 px-4 py-2 min-h-[60px] border-b border-gilt-b">
            <Avatar avatar={p.avatar} name={p.name} />
            <button onClick={() => setEditing(p)} className="flex-1 min-w-0 min-h-[44px] text-left active:opacity-60">
              <div className="text-[15px] font-medium truncate">
                {p.name} {activeId === p.id && <span className="text-xs text-success">● active</span>}
              </div>
              <div className="text-xs gm-mut font-mono truncate">{p.model}</div>
            </button>
            {activeId !== p.id && (
              <button
                onClick={async () => {
                  try {
                    await setActiveProfile(p.id);
                    setActiveId(p.id);
                  } catch (e) {
                    setErr(errMsg(e));
                  }
                }}
                className="g-btn g-btn-gilt g-btn-sm min-h-[44px]"
              >
                Activate
              </button>
            )}
          </div>
        ))
      )}
      <div className="p-4">
        <Button full onClick={() => setEditing(null)}>
          + New personality
        </Button>
      </div>
      {editing !== undefined && (
        <ProfileSheet
          key={editing?.id ?? "new"}
          profile={editing}
          models={models}
          onClose={() => setEditing(undefined)}
          onSaved={() => {
            setEditing(undefined);
            void load();
          }}
        />
      )}
    </div>
  );
}

function ProfileSheet({
  profile,
  models,
  onClose,
  onSaved,
}: {
  profile: ModelProfile | null;
  models: string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(profile?.name ?? "");
  const [model, setModel] = useState(profile?.model ?? models[0] ?? "");
  const [prompt, setPrompt] = useState(profile?.system_prompt ?? "");
  const [temp, setTemp] = useState(profile?.temperature != null ? String(profile.temperature) : "0.7");
  const [max, setMax] = useState(profile?.max_tokens != null ? String(profile.max_tokens) : "");
  const [avatar, setAvatar] = useState<string | null>(profile?.avatar ?? null);
  const [meta, setMeta] = useState<ModelMeta | null>(parseModelMeta(profile?.model_meta));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!model.trim()) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      getModelInfo(model.trim())
        .then((m) => !cancelled && setMeta(m))
        .catch(() => {});
    }, 400); // debounce — don't probe on every keystroke of a free-text model field
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [model]);

  const pick = (f: File | null) => {
    if (!f) return;
    if (f.size > 512 * 1024) {
      setErr("Image too large — pick one under 512 KB.");
      return;
    }
    const r = new FileReader();
    r.onload = () => setAvatar(typeof r.result === "string" ? r.result : null);
    r.readAsDataURL(f);
  };
  const save = async () => {
    if (!name.trim() || !model.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      await upsertProfile({
        id: profile?.id,
        name: name.trim(),
        model: model.trim(),
        system_prompt: prompt.trim() || undefined,
        temperature: temp.trim() ? Number(temp) : undefined,
        max_tokens: max.trim() ? Number(max) : undefined,
        avatar,
      });
      onSaved();
    } catch (e) {
      setErr(errMsg(e));
      setBusy(false);
    }
  };
  const del = async () => {
    if (!profile) return;
    if (!await confirmDialog(`Delete "${profile.name}"?`)) return;
    try {
      await deleteProfile(profile.id);
      onSaved();
    } catch (e) {
      setErr(errMsg(e));
    }
  };

  const caps = (meta?.capabilities ?? []).filter(Boolean);
  return (
    <Sheet
      title={profile ? "Edit personality" : "New personality"}
      onClose={onClose}
      footer={
        <Button full onClick={save} disabled={busy || !name.trim() || !model.trim()}>
          {busy ? "Saving…" : "Save"}
        </Button>
      }
    >
      <div className="flex items-center gap-3">
        <Avatar avatar={avatar} name={name || "A"} size={56} />
        <label className="g-btn g-btn-ghost min-h-[44px] px-3 text-sm cursor-pointer">
          {avatar ? "Change picture" : "Add picture"}
          <input
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              pick(e.target.files?.[0] ?? null);
              e.currentTarget.value = "";
            }}
          />
        </label>
        {avatar && (
          <button onClick={() => setAvatar(null)} className="text-sm text-error min-h-[44px] px-2 active:opacity-60">
            Remove
          </button>
        )}
      </div>
      <Field label="Name">
        <TextInput value={name} onChange={setName} placeholder="Project assistant" />
      </Field>
      <Field label="Model">
        {models.length > 0 ? (
          <Select
            value={model}
            onChange={setModel}
            options={[
              { value: "", label: "Select a model…" },
              ...models.map((m) => ({ value: m, label: m })),
              ...(model && !models.includes(model) ? [{ value: model, label: `${model} (saved)` }] : []),
            ]}
          />
        ) : (
          <TextInput value={model} onChange={setModel} placeholder="llama3.1:8b" />
        )}
      </Field>
      {(meta?.context_length || meta?.parameter_size || caps.length > 0) && (
        <div className="flex flex-wrap gap-1.5 text-[11px]">
          {meta?.context_length ? (
            <span className="g-tag">{Math.round(meta.context_length / 1024)}K context</span>
          ) : null}
          {meta?.parameter_size && <span className="g-tag">{meta.parameter_size}</span>}
          {caps.map((c) => (
            <span key={c} className="g-tag bg-gilt-b text-gold">{c}</span>
          ))}
        </div>
      )}
      <Field label="System prompt">
        <TextArea value={prompt} onChange={setPrompt} rows={4} placeholder="How it should behave…" />
      </Field>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Temperature">
          <TextInput value={temp} onChange={setTemp} inputMode="decimal" placeholder="0.7" />
        </Field>
        <Field label="Max tokens">
          <TextInput value={max} onChange={setMax} inputMode="numeric" placeholder="—" />
        </Field>
      </div>
      {err && <p className="text-sm text-error">{err}</p>}
      {profile && (
        <Button full variant="danger" onClick={del}>
          Delete personality
        </Button>
      )}
    </Sheet>
  );
}

// ── A project's chat threads ────────────────────────────────────────────────

/** Threads in one project: the caller's own plus any teammate-published ones. */
export function ProjectChatsScreen({ project }: { project: Project }) {
  const nav = useNav();
  const { data, loading, error, reload } = useAsync(() => listChats(project.id), [project.id]);
  const chats = data ?? [];

  const openThread = (chat?: Chat) =>
    nav.push(<ChatThreadScreen project={project} chat={chat} onThreadChange={reload} />);

  return (
    <Screen title={project.name} subtitle="Assistant" onBack={nav.pop} right={<RefreshBtn onClick={reload} />}>
      {error && <ErrorBanner message={error} onRetry={reload} />}
      {loading && !data ? (
        <Spinner />
      ) : chats.length === 0 ? (
        <EmptyState text="No chats yet. Tap + to ask the assistant something." />
      ) : (
        <div className="pb-24">
          {chats.map((c) => (
            <button
              key={c.id}
              onClick={() => openThread(c)}
              className="gm-row"
            >
              <span className="flex-1 min-w-0">
                <span className="block truncate text-[15px] font-medium">{c.title ?? "Untitled chat"}</span>
                <span className="block text-[13px] gm-mut truncate">
                  {new Date(c.updated_at).toLocaleDateString()}
                </span>
              </span>
              {c.is_public && (
                <Badge className="bg-gilt-b text-gold">{c.is_mine ? "🌐 Shared" : "👥 Team"}</Badge>
              )}
              <span className="text-overlay-1">›</span>
            </button>
          ))}
        </div>
      )}
      <Fab onClick={() => openThread()} label="New chat" />
    </Screen>
  );
}

// ── A single conversation (streaming) ───────────────────────────────────────

type StreamPhase = { phase: "retrieving" | "generating"; model?: string };

function StreamStatus({ phase, model }: StreamPhase) {
  const label = phase === "retrieving" ? "Searching this project…" : `Generating${model ? ` · ${model}` : ""}…`;
  return (
    <span className="inline-flex items-center gap-2 gm-mut text-sm">
      <span className="inline-block w-3.5 h-3.5 border-2 border-current border-t-transparent rounded-full animate-spin" />
      {label}
    </span>
  );
}

function SourcesCard({ sources }: { sources: ChatSource[] }) {
  const [open, setOpen] = useState(false);
  if (!sources.length) return null;
  return (
    <div className="mt-2 pt-2 border-t border-gilt-b">
      <button onClick={() => setOpen((o) => !o)} className="flex items-center gap-1.5 min-h-[44px] text-xs gm-mut active:opacity-60">
        🔍 Used {sources.length} reference{sources.length === 1 ? "" : "s"}
        <span className={`transition-transform ${open ? "rotate-90" : ""}`}>›</span>
      </button>
      {open && (
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {sources.map((s, j) => (
            <span key={j} className="text-[11px] px-2 py-0.5 rounded bg-surface-0 gm-fg2 break-all">
              {sourceLabel(s)}: {s.source}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/** Chips listing the read tools the agent invoked for a turn. */
function ToolChips({ tools }: { tools: string[] }) {
  if (!tools.length) return null;
  return (
    <div className="mt-2 pt-2 border-t border-gilt-b">
      <div className="text-[11px] gm-mut mb-1">🔧 Looked up</div>
      <div className="flex flex-wrap gap-1">
        {tools.map((t, k) => (
          <span key={k} className="text-[11px] px-2 py-0.5 rounded bg-surface-0 gm-fg2 break-all">
            {t}
          </span>
        ))}
      </div>
    </div>
  );
}

type ProposalStatus = "applying" | "applied" | "dismissed" | "error";

/** Compact field-level diff rows from a proposal's before/after snapshot. */
function diffRows(details?: ProposalDetails): { key: string; before?: string; after?: string }[] {
  if (!details) return [];
  const before = details.before ?? {};
  const after = details.after ?? {};
  const show = (v: unknown): string => (v == null || v === "" ? "—" : typeof v === "string" ? v : JSON.stringify(v));
  return Array.from(new Set([...Object.keys(before), ...Object.keys(after)]))
    .filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]))
    .map((k) => ({
      key: k,
      before: k in before ? show(before[k]) : undefined,
      after: k in after ? show(after[k]) : undefined,
    }));
}

/** One gated write the assistant proposed: summary, optional before→after
 * details, and big touch targets to approve or dismiss it. */
function ProposalCard({
  proposal,
  status,
  onApprove,
  onDismiss,
}: {
  proposal: ProposalPayload;
  status?: ProposalStatus;
  onApprove: () => void;
  onDismiss: () => void;
}) {
  const [open, setOpen] = useState(false);
  const rows = diffRows(proposal.details);
  return (
    <div className="g-card px-3.5 py-3">
      <div className="text-[0.9rem] break-words">{proposal.summary}</div>
      {rows.length > 0 && (
        <>
          <button
            onClick={() => setOpen((o) => !o)}
            className="mt-1 flex items-center gap-1 min-h-[44px] text-xs gm-mut active:opacity-60"
          >
            What changes <span className={`transition-transform ${open ? "rotate-90" : ""}`}>›</span>
          </button>
          {open && (
            <div className="mt-0.5 space-y-1">
              {rows.map((r) => (
                <div key={r.key} className="text-[11px] leading-snug break-words">
                  <span className="gm-mut">{r.key}: </span>
                  {r.before !== undefined && <span className="text-error line-through decoration-error/40">{r.before}</span>}
                  {r.before !== undefined && r.after !== undefined && <span className="gm-mut"> → </span>}
                  {r.after !== undefined && <span className="text-success">{r.after}</span>}
                </div>
              ))}
            </div>
          )}
        </>
      )}
      <div className="mt-2">
        {status === "applying" ? (
          <span className="inline-flex items-center gap-2 text-xs gm-mut">
            <span className="inline-block w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin" />
            Applying…
          </span>
        ) : status === "applied" ? (
          <span className="text-xs text-success">✓ Applied</span>
        ) : status === "dismissed" ? (
          <span className="text-xs gm-mut">Dismissed</span>
        ) : status === "error" ? (
          <div className="flex items-center gap-3">
            <span className="text-xs text-error">Failed to apply</span>
            <button onClick={onApprove} className="g-btn g-btn-sm min-h-[44px] active:bg-surface-1">
              Retry
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <button
              onClick={onApprove}
              className="g-btn g-btn-pri flex-1 min-h-[44px] px-3 active:bg-primary-hover"
            >
              Approve
            </button>
            <button
              onClick={onDismiss}
              className="g-btn g-btn-ghost flex-1 min-h-[44px] px-3 active:bg-surface-0"
            >
              Dismiss
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function AssistantAvatar({ profile, size = 30 }: { profile: ModelProfile | null; size?: number }) {
  if (profile?.avatar) {
    return <img src={profile.avatar} alt="" className="rounded-full object-cover shrink-0" style={{ width: size, height: size }} />;
  }
  return (
    <div
      className="g-av"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.5) }}
    >
      🤖
    </div>
  );
}

function ChatThreadScreen({
  project,
  chat,
  onThreadChange,
}: {
  project: Project;
  chat?: Chat;
  onThreadChange: () => void;
}) {
  const nav = useNav();
  const [chatId, setChatId] = useState<number | undefined>(chat?.id);
  const [meta, setMeta] = useState<Chat | undefined>(chat);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  // Opt-in agentic tools (per-conversation, default off — each thread is its own
  // screen instance, so a new/changed conversation naturally starts fresh).
  const [useTools, setUseTools] = useState(false);
  // Per-proposal approval status, keyed by (globally-unique) proposal id.
  const [proposalStatus, setProposalStatus] = useState<Record<number, ProposalStatus>>({});
  const [streamPhase, setStreamPhase] = useState<StreamPhase | null>(null);
  const [assistant, setAssistant] = useState<ModelProfile | null>(null);
  const [profiles, setProfiles] = useState<ModelProfile[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loadingHistory, setLoadingHistory] = useState(!!chat);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Authorship is server-decided (Chat.is_mine); a brand-new thread is ours.
  const isMine = meta?.is_mine ?? true;
  const readOnly = !!meta && !isMine;

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, streamPhase]);

  // Abort any in-flight stream if the user leaves the thread.
  useEffect(() => () => abortRef.current?.abort(), []);

  useEffect(() => {
    listProfiles()
      .then((r) => {
        setProfiles(r.profiles);
        setAssistant(r.profiles.find((p) => p.id === r.active_id) ?? null);
      })
      .catch(() => {/* host may have no profiles */});
  }, []);

  // @mention routing: if the message names a personality, route this turn to it.
  const mentionedId = (text: string): number | undefined => {
    const lower = text.toLowerCase();
    for (const p of [...profiles].sort((a, b) => b.name.length - a.name.length)) {
      if (p.name && lower.includes(`@${p.name.toLowerCase()}`)) return p.id;
    }
    return undefined;
  };

  useEffect(() => {
    if (!chat) return;
    let cancelled = false;
    getChatMessages(chat.id)
      .then((msgs) => {
        if (cancelled) return;
        setMessages(
          msgs.map((m) => ({
            role: m.role === "assistant" ? "assistant" : "user",
            content: m.content,
            sources: parseSources(m.sources_json),
            tools: parseTools(m.tools_json),
          }))
        );
      })
      .catch((e) => !cancelled && setError(errMsg(e)))
      .finally(() => !cancelled && setLoadingHistory(false));
    return () => {
      cancelled = true;
    };
  }, [chat]);

  const setLastAssistant = (fn: (m: Msg) => Msg) =>
    setMessages((ms) => {
      const c = [...ms];
      for (let i = c.length - 1; i >= 0; i--) {
        if (c[i].role === "assistant") {
          c[i] = fn(c[i]);
          break;
        }
      }
      return c;
    });

  const send = async () => {
    const msg = input.trim();
    if (!msg || sending) return;
    setInput("");
    setError(null);
    setSending(true);
    setStreamPhase({ phase: "retrieving" });
    setMessages((m) => [...m, { role: "user", content: msg }, { role: "assistant", content: "" }]);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      await streamChat(
        { project_id: project.id, chat_id: chatId, message: msg, profile_id: mentionedId(msg), use_tools: useTools },
        {
          onToken: (d) => {
            setStreamPhase((p) => (p && p.phase === "retrieving" ? { ...p, phase: "generating" } : p));
            setLastAssistant((a) => ({ ...a, content: a.content + d }));
          },
          onSources: (s) => setLastAssistant((a) => ({ ...a, sources: s })),
          onTools: (names) => setLastAssistant((a) => ({ ...a, tools: names })),
          onProposals: (ps) => setLastAssistant((a) => ({ ...a, proposals: ps })),
          onStage: (info) =>
            setStreamPhase({ phase: info.stage === "generating" ? "generating" : "retrieving", model: info.model }),
          onDone: (info) => {
            if (!chatId) {
              setChatId(info.chat_id);
              onThreadChange();
            }
          },
          onError: (e) => {
            setError(e);
            setMessages((m) =>
              m[m.length - 1]?.role === "assistant" && !m[m.length - 1].content ? m.slice(0, -1) : m
            );
          },
        },
        controller.signal
      );
    } catch (e) {
      if (controller.signal.aborted) return; // left the thread mid-stream
      setError(
        e instanceof DaemonError
          ? e.message.includes("not enabled")
            ? "Chat isn't enabled on the host yet — set up Ollama in Settings → AI Engines on the host."
            : `Couldn't reach the host: ${e.message}`
          : errMsg(e)
      );
      setMessages((m) => (m[m.length - 1]?.role === "assistant" && !m[m.length - 1].content ? m.slice(0, -1) : m));
    } finally {
      if (!controller.signal.aborted) {
        setSending(false);
        setStreamPhase(null);
      }
    }
  };

  const approveProposal = async (p: ToolProposal) => {
    const st = proposalStatus[p.id];
    if (st === "applying" || st === "applied") return; // guard double-tap
    setProposalStatus((s) => ({ ...s, [p.id]: "applying" }));
    try {
      await executeProposal(p.id);
      setProposalStatus((s) => ({ ...s, [p.id]: "applied" }));
    } catch (e) {
      setProposalStatus((s) => ({ ...s, [p.id]: "error" }));
      setError(errMsg(e));
    }
  };
  const dismissProposal = (id: number) => {
    setProposalStatus((s) => ({ ...s, [id]: "dismissed" }));
    // Consume it server-side too (ledgered as rejected). Best-effort: if the
    // call fails the proposal just expires unused, same as before.
    void rejectProposal(id).catch(() => {});
  };

  const togglePublic = async () => {
    if (!meta) return;
    try {
      const updated = await setChatPublic(meta.id, !meta.is_public);
      setMeta({ ...meta, is_public: updated.is_public });
      onThreadChange();
    } catch (e) {
      setError(errMsg(e));
    }
  };

  return (
    <div className="flex flex-col h-full bg-mantle text-text">
      {/* Header (matches the Gilt TopBar, with the assistant's vCard identity) */}
      <header className="sticky top-0 z-10 bg-crust border-b border-gilt-a" style={{ paddingTop: "env(safe-area-inset-top)" }}>
        <div className="flex items-center gap-2 px-2 min-h-[56px]">
          <button onClick={nav.pop} className="g-iconbtn w-11 h-11 text-gold active:bg-surface-0" aria-label="Back">
            <svg viewBox="0 0 24 24" className="w-6 h-6" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden="true">
              <path d="M15 5l-7 7 7 7" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <AssistantAvatar profile={assistant} size={30} />
          <div className="flex-1 min-w-0 py-1.5">
            <h1 className="g-deco text-[15px] font-semibold text-gold truncate leading-snug pt-0.5" style={{ letterSpacing: "0.16em" }}>{assistant?.name ?? "Assistant"}</h1>
            <div className="text-xs gm-mut truncate">
              {readOnly ? "Shared by a teammate — read-only" : project.name}
            </div>
          </div>
          {meta && !readOnly && (
            <button
              onClick={togglePublic}
              className={`shrink-0 text-xs min-h-[44px] px-3 rounded active:opacity-60 ${
                meta.is_public ? "text-gold" : "gm-mut"
              }`}
            >
              {meta.is_public ? "🌐 Shared" : "Share"}
            </button>
          )}
        </div>
      </header>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto overscroll-contain px-3 py-4 space-y-3">
        {loadingHistory ? (
          <Spinner />
        ) : messages.length === 0 ? (
          <p className="text-center gm-mut text-sm mt-8">Ask anything about {project.name}.</p>
        ) : (
          messages.map((m, i) => {
            const isLast = i === messages.length - 1;
            const streaming = m.role === "assistant" && isLast && sending && !m.content;
            return (
              <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
                <div
                  className={`rounded-xl px-3.5 py-2.5 max-w-[85%] min-[700px]:max-w-[72ch] whitespace-pre-wrap text-[15px] leading-relaxed break-words ${
                    m.role === "user" ? "bg-primary text-primary-text" : "bg-base border border-gilt-a"
                  }`}
                >
                  {m.content ? m.content : streaming ? <StreamStatus {...(streamPhase ?? { phase: "retrieving" })} /> : ""}
                  {m.tools && m.tools.length > 0 && <ToolChips tools={m.tools} />}
                  {m.sources && m.sources.length > 0 && <SourcesCard sources={m.sources} />}
                  {m.proposals && m.proposals.length > 0 && (
                    <div className="mt-2 pt-2 border-t border-gilt-b space-y-2">
                      <div className="g-flbl mb-0">Proposed changes — approve to apply</div>
                      {m.proposals.map((p) => (
                        <ProposalCard
                          key={p.id}
                          proposal={p}
                          status={proposalStatus[p.id]}
                          onApprove={() => approveProposal(p)}
                          onDismiss={() => dismissProposal(p.id)}
                        />
                      ))}
                    </div>
                  )}
                </div>
              </div>
            );
          })
        )}
        {error && (
          <div className="text-sm text-error bg-error/10 border border-error/40 rounded px-3 py-2">{error}</div>
        )}
      </div>

      {/* Composer (pinned; safe-area aware) */}
      <div className="shrink-0 border-t border-gilt-a bg-crust px-3 py-2" style={{ paddingBottom: "calc(0.5rem + env(safe-area-inset-bottom))" }}>
        {readOnly ? (
          <p className="text-center text-xs gm-mut py-2">
            A teammate's shared chat — you can read it, but only the author can continue it.
          </p>
        ) : (
          <>
          {profiles.length > 1 && (
            <div className="flex items-center gap-1.5 overflow-x-auto pb-1.5 mb-1 text-xs">
              <span className="shrink-0 g-flbl mb-0">Tag</span>
              {profiles.map((p) => (
                <button
                  key={p.id}
                  onClick={() => {
                    setInput((v) => `${v}${v && !v.endsWith(" ") ? " " : ""}@${p.name} `);
                    textareaRef.current?.focus();
                  }}
                  className="gm-chip gm-chip-sm shrink-0"
                >
                  @{p.name}
                </button>
              ))}
            </div>
          )}
          <div className="flex items-center gap-2 mb-1.5">
            <button
              onClick={() => setUseTools((v) => !v)}
              aria-pressed={useTools}
              className="gm-chip gm-chip-sm shrink-0"
            >
              🔧 Tools {useTools ? "on" : "off"}
            </button>
            {useTools && (
              <span className="min-w-0 truncate text-[11px] gm-mut">
                Can look up project data &amp; propose changes
              </span>
            )}
          </div>
          <div className="flex items-end gap-2">
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onFocus={() => setTimeout(() => textareaRef.current?.scrollIntoView({ behavior: "smooth", block: "end" }), 250)}
              rows={1}
              placeholder="Message the assistant… (@name for a specific agent)"
              disabled={sending}
              className="g-field gm-field gm-composer flex-1 min-w-0 resize-none max-h-32"
            />
            <Button onClick={send} disabled={sending || !input.trim()}>
              {sending ? "…" : "Send"}
            </Button>
          </div>
          </>
        )}
      </div>
    </div>
  );
}
