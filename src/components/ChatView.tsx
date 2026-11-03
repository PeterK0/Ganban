import { useEffect, useRef, useState } from "react";
import { confirmDialog } from '../lib/confirm';
import { useAppStore } from "../store/appStore";
import IndexingPanel from "./IndexingPanel";
import ModelProfilesPanel, { ModelCard, ProfileAvatar } from "./ModelProfilesPanel";
import OraclePanel from "./OraclePanel";
import { useContextMenu } from "./ContextMenu";
import BridgePanel from "./BridgePanel";
import CorpusLensPanel from "./CorpusLensPanel";
import ToolsPanel from "./ToolsPanel";
import ActivityView from "./ActivityView";
import { ASSISTANT_TREE_W } from "../lib/ui";
import MarkdownPreview from "./MarkdownPreview";
import { TabIcon, type TabIconName } from "./icons/TabIcon";
import { PinGlyph } from "./PinnedTabs";

type AssistantTab = "chats" | "corpus" | "indexing" | "models" | "oracle" | "bridge" | "tools" | "activity";
const ASSISTANT_TABS: { id: AssistantTab; label: string; icon: TabIconName }[] = [
  { id: "chats", label: "Chats", icon: "chats" },
  { id: "corpus", label: "Corpus", icon: "search" },
  { id: "indexing", label: "Indexing", icon: "layers" },
  { id: "models", label: "Agents", icon: "bot" },
  { id: "oracle", label: "Oracle", icon: "oracle" },
  { id: "bridge", label: "Bridge", icon: "compass" },
  { id: "tools", label: "Tools", icon: "wrench" },
  { id: "activity", label: "Activity", icon: "activity" },
];
import {
  DaemonError,
  streamChat,
  executeProposal,
  rejectProposal,
  hasDaemon,
  listChats,
  getChatMessages,
  binChat,
  restoreChat,
  purgeChat,
  listBinnedChats,
  setChatPublic,
  setChatPinned,
  listProfiles,
  parseModelMeta,
  type Chat,
  type ChatSource,
  type ModelProfile,
  type ToolProposal,
} from "../lib/daemon";
import { getUser } from "../lib/api";
import { parseProfile } from "../lib/profile";

interface Msg {
  role: "user" | "assistant";
  content: string;
  sources?: ChatSource[];
  /** Read tools the agent invoked this turn (when Tools mode was on). */
  tools?: string[];
  /** Write actions the agent proposed this turn (await approval). */
  proposals?: ToolProposal[];
  /** Server-measured token usage for this turn (for the tok/s readout). */
  usage?: { prompt_tokens: number; completion_tokens: number; duration_ms: number };
}

/** Generation rate from server-measured usage (turn tokens / turn duration). */
function fmtTokps(u: { completion_tokens: number; duration_ms: number }): string {
  if (!u.duration_ms || u.completion_tokens <= 0) return "";
  return (u.completion_tokens / (u.duration_ms / 1000)).toFixed(1);
}

/** Short relative time from a host timestamp (ISO, or SQLite "YYYY-MM-DD HH:MM:SS" UTC). */
function relTime(s: string): string {
  const d = new Date(s.includes("T") ? s : s.replace(" ", "T") + "Z");
  if (isNaN(d.getTime())) return "";
  const mins = Math.floor((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const h = Math.floor(mins / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.floor(h / 24);
  return days < 7 ? `${days}d ago` : d.toLocaleDateString();
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

// The thread column: grows with the window and stays centred (Gilt, ultrawide);
// bubbles inside cap their own line length.
const THREAD_COL = "w-full max-w-[clamp(48rem,58vw,72rem)] mx-auto";

type StreamPhase = { phase: "retrieving" | "generating"; model?: string };

/** If a message @mentions a personality by name, return its id so this turn is
 * routed to it (longest name first, so the most specific mention wins). No
 * mention → undefined → the active personality answers. */
function resolveMention(text: string, profiles: ModelProfile[]): number | undefined {
  const lower = text.toLowerCase();
  for (const p of [...profiles].sort((a, b) => b.name.length - a.name.length)) {
    if (p.name && lower.includes(`@${p.name.toLowerCase()}`)) return p.id;
  }
  return undefined;
}

/** The assistant's profile picture (custom image or an initial), shown so the
 * personality's "vCard" identity is visible in the conversation. */
function AssistantAvatar({ profile, size = 28 }: { profile: ModelProfile | null; size?: number }) {
  if (profile?.avatar) {
    return <img src={profile.avatar} alt="" className="rounded-full object-cover shrink-0" style={{ width: size, height: size }} />;
  }
  return (
    <div
      className="rounded-full bg-surface-2 text-subtext-0 flex items-center justify-center shrink-0"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.5) }}
    >
      🤖
    </div>
  );
}

/** Animated "what the assistant is doing right now" line, shown in place of the
 * empty answer bubble until tokens start flowing. */
function StreamStatus({ phase, model }: StreamPhase) {
  const label =
    phase === "retrieving"
      ? "Searching this project…"
      : `Generating${model ? ` · ${model}` : ""}…`;
  return (
    <span className="inline-flex items-center gap-2 text-subtext-0">
      <span className="inline-block w-3.5 h-3.5 border-2 border-subtext-0 border-t-transparent rounded-full animate-spin" />
      {label}
    </span>
  );
}

/** Collapsible "tool use" card: which project references the answer was grounded
 * in. Appears as soon as retrieval finishes (before the answer is written). */
function SourcesCard({ sources }: { sources: ChatSource[] }) {
  const [open, setOpen] = useState(false);
  if (!sources.length) return null;
  return (
    <div className="mt-2 pt-2 border-t border-surface-1">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 min-h-8 text-[11px] text-[color:var(--g-mut)] hover:text-text"
      >
        <span>🔍</span>
        <span>
          Used {sources.length} reference{sources.length === 1 ? "" : "s"} from this project
        </span>
        <span className={`transition-transform ${open ? "rotate-90" : ""}`}>›</span>
      </button>
      {open && (
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {sources.map((s, j) => (
            <span
              key={j}
              className="g-tag !min-h-[22px] !px-2 !text-[11px] max-w-full truncate"
              title={s.source}
            >
              {sourceLabel(s)}: {s.source}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * The Assistant — a file-explorer over per-project chats. Projects on the left
 * are "folders"; each holds its chat threads (grounded in that project's tasks,
 * events, notes and files). The right pane is the active conversation. Chat runs
 * on the host, so it's gated on having a daemon connection.
 */
export default function ChatView({ scopeProjectId, initialChatId }: { scopeProjectId?: number; initialChatId?: number } = {}) {
  const { projects } = useAppStore();
  const active = projects.filter((p) => !p.archived && (scopeProjectId == null || p.id === scopeProjectId));
  const [openProject, setOpenProject] = useState<number | null>(scopeProjectId ?? null);
  const [chatsByProject, setChatsByProject] = useState<Record<number, Chat[]>>({});
  const [activeChat, setActiveChat] = useState<{ projectId: number; chatId?: number } | null>(null);
  // Author avatar/name per user id — so user messages show WHO wrote them
  // (chats can be shared; only the author writes, so one author per chat).
  const [userById, setUserById] = useState<Record<number, { avatar?: string; name: string }>>({});
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  // Opt-in agentic tools: let the assistant fetch this project's data (reads run
  // automatically) and propose changes (gated — applied only when you approve).
  const [useTools, setUseTools] = useState(false);
  // Per-proposal approval status, keyed by (globally-unique) proposal id.
  const [proposalStatus, setProposalStatus] = useState<Record<number, "applying" | "applied" | "dismissed" | "error">>({});
  const ctxMenu = useContextMenu();
  const [streamPhase, setStreamPhase] = useState<StreamPhase | null>(null);
  // Live tok/s while generating: count streamed deltas since the first token.
  const [liveTokps, setLiveTokps] = useState<number | null>(null);
  const streamStatsRef = useRef<{ start: number; tokens: number } | null>(null);
  const [activeProfileId, setActiveProfileId] = useState<number | null>(null);
  const [profiles, setProfiles] = useState<ModelProfile[]>([]);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const connected = hasDaemon();
  const [tab, setTab] = useState<AssistantTab>("chats");

  // Deep-link: outside surfaces (the hot-bar Bridge dropdown) can request a
  // specific assistant tab — via sessionStorage when we're not mounted yet
  // (view switch + tab request in one click), via event when we are.
  useEffect(() => {
    const KEY = 'ganban:assistant-tab';
    const wanted = sessionStorage.getItem(KEY);
    if (wanted) {
      sessionStorage.removeItem(KEY);
      setTab(wanted as AssistantTab);
    }
    const onRequest = (e: Event) => {
      const t = (e as CustomEvent<string>).detail;
      if (t) setTab(t as AssistantTab);
    };
    window.addEventListener(KEY, onRequest);
    return () => window.removeEventListener(KEY, onRequest);
  }, []);

  // The active personality answers by default; all profiles are matchable via
  // @mention so you can route a turn to another one mid-conversation.
  useEffect(() => {
    if (!connected) return;
    listProfiles()
      .then((r) => {
        setProfiles(r.profiles);
        setActiveProfileId(r.active_id);
      })
      .catch(() => {/* host may not have profiles configured */});
  }, [connected]);

  // Authorship is decided by the server (Chat.is_mine), not the client's notion
  // of "current user" — the two diverge on a loopback host. A brand-new thread
  // not yet in the list is ours by default.
  const isMine = (c: Chat) => c.is_mine ?? true;

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages]);

  const activeChatMeta =
    activeChat?.chatId != null
      ? (chatsByProject[activeChat.projectId] ?? []).find((c) => c.id === activeChat.chatId)
      : undefined;
  // A teammate's shared thread is read-only for us.
  const readOnly = !!activeChatMeta && !isMine(activeChatMeta);

  const togglePublic = async () => {
    if (!activeChatMeta) return;
    try {
      await setChatPublic(activeChatMeta.id, !activeChatMeta.is_public);
      await loadChats(activeChatMeta.project_id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const loadChats = async (pid: number) => {
    try {
      const chats = await listChats(pid);
      setChatsByProject((c) => ({ ...c, [pid]: chats }));
    } catch {
      /* ignore — host may be down */
    }
  };

  // Two-stage chat deletion: bin (restorable, shown in a per-project Bin
  // section) → delete forever (the host refuses unless binned first).
  const [binnedByProject, setBinnedByProject] = useState<Record<number, Chat[]>>({});
  const [binOpen, setBinOpen] = useState<Record<number, boolean>>({});
  const loadBinned = async (pid: number) => {
    try {
      setBinnedByProject((b) => ({ ...b, [pid]: [] }));
      const binned = await listBinnedChats(pid);
      setBinnedByProject((b) => ({ ...b, [pid]: binned }));
    } catch {
      /* older host — no bin routes yet */
    }
  };
  const binThisChat = async (pid: number, c: Chat) => {
    try {
      await binChat(c.id);
      if (activeChat?.chatId === c.id) setActiveChat(null);
      await loadChats(pid);
      if (binOpen[pid]) await loadBinned(pid);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const pinThisChat = async (pid: number, c: Chat) => {
    try {
      await setChatPinned(c.id, !c.pinned);
      await loadChats(pid); // re-sort: pinned float to the top
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const restoreThisChat = async (pid: number, c: Chat) => {
    try {
      await restoreChat(c.id);
      await Promise.all([loadChats(pid), loadBinned(pid)]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const purgeThisChat = async (pid: number, c: Chat) => {
    if (!await confirmDialog(`Delete “${c.title ?? "Untitled chat"}” forever? The whole conversation is gone for good.`)) return;
    try {
      await purgeChat(c.id);
      await loadBinned(pid);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const toggleProject = async (pid: number) => {
    if (openProject === pid) {
      setOpenProject(null);
      return;
    }
    setOpenProject(pid);
    if (!chatsByProject[pid]) await loadChats(pid);
  };

  // When embedded in a project tab, open that project's chats immediately.
  useEffect(() => {
    if (scopeProjectId != null && connected) {
      setOpenProject(scopeProjectId);
      if (!chatsByProject[scopeProjectId]) void loadChats(scopeProjectId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeProjectId, connected]);

  const openChat = async (pid: number, chatId: number) => {
    setActiveChat({ projectId: pid, chatId });
    setUseTools(false); // Tools mode is per-conversation: start each thread fresh.
    setProposalStatus({});
    setError(null);
    try {
      const msgs = await getChatMessages(chatId);
      setMessages(
        msgs.map((m) => ({
          role: m.role === "assistant" ? "assistant" : "user",
          content: m.content,
          sources: parseSources(m.sources_json),
          tools: parseTools(m.tools_json),
        }))
      );
    } catch (e) {
      setMessages([]);
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const newChat = (pid: number) => {
    setOpenProject(pid);
    setActiveChat({ projectId: pid });
    setMessages([]);
    setUseTools(false); // fresh conversation → tools opt-in resets
    setProposalStatus({});
    setError(null);
  };

  // Deep-link: open a specific thread when asked (e.g. clicked from project Home).
  useEffect(() => {
    if (initialChatId != null && scopeProjectId != null && connected) {
      void openChat(scopeProjectId, initialChatId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialChatId, scopeProjectId, connected]);

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
    if (!msg || sending || !activeChat) return;
    const pid = activeChat.projectId;
    setInput("");
    setError(null);
    setSending(true);
    setStreamPhase({ phase: "retrieving" });
    streamStatsRef.current = null;
    setLiveTokps(null);
    setMessages((m) => [...m, { role: "user", content: msg }, { role: "assistant", content: "" }]);
    let streamedAny = false;
    try {
      await streamChat(
        { project_id: pid, chat_id: activeChat.chatId, message: msg, profile_id: resolveMention(msg, profiles), use_tools: useTools },
        {
          onToken: (d) => {
            streamedAny = true;
            const st = streamStatsRef.current ?? (streamStatsRef.current = { start: performance.now(), tokens: 0 });
            st.tokens += 1;
            const el = (performance.now() - st.start) / 1000;
            if (el > 0.3) setLiveTokps(st.tokens / el);
            setStreamPhase((p) => (p && p.phase === "retrieving" ? { ...p, phase: "generating" } : p));
            setLastAssistant((a) => ({ ...a, content: a.content + d }));
          },
          onSources: (s) => setLastAssistant((a) => ({ ...a, sources: s })),
          onTools: (names) => setLastAssistant((a) => ({ ...a, tools: names })),
          onProposals: (ps) => setLastAssistant((a) => ({ ...a, proposals: ps })),
          onStage: (info) =>
            setStreamPhase({ phase: info.stage === "generating" ? "generating" : "retrieving", model: info.model }),
          onDone: (info) => {
            if (info.usage) setLastAssistant((a) => ({ ...a, usage: info.usage }));
            setLiveTokps(null);
            // First message in a new thread: adopt its id + refresh the folder.
            if (!activeChat.chatId) {
              setActiveChat({ projectId: pid, chatId: info.chat_id });
              loadChats(pid);
            }
            // A tool-only turn streams no prose; the host persisted a summary
            // of what happened instead — show it rather than an empty bubble.
            if (!streamedAny) {
              getChatMessages(info.chat_id)
                .then((msgs) => {
                  const last = msgs[msgs.length - 1];
                  if (last?.role === "assistant" && last.content) {
                    setLastAssistant((cur) => (cur.content ? cur : { ...cur, content: last.content }));
                  }
                })
                .catch(() => {});
            }
          },
          onError: (e) => {
            setError(e);
            // An SSE 'error' event doesn't throw, so the catch below won't run —
            // drop the empty assistant bubble here too.
            setMessages((m) =>
              m[m.length - 1]?.role === "assistant" && !m[m.length - 1].content ? m.slice(0, -1) : m
            );
          },
        }
      );
    } catch (e) {
      setError(
        e instanceof DaemonError
          ? e.message.includes("not enabled")
            ? "Chat isn't enabled on the host yet — set up Ollama in Settings → AI Engines."
            : `Couldn't reach the host: ${e.message}`
          : e instanceof Error
            ? e.message
            : String(e)
      );
      setMessages((m) => (m[m.length - 1]?.role === "assistant" && !m[m.length - 1].content ? m.slice(0, -1) : m));
    } finally {
      setSending(false);
      setStreamPhase(null);
      setLiveTokps(null);
    }
  };

  const approveProposal = async (p: ToolProposal) => {
    const st = proposalStatus[p.id];
    if (st === "applying" || st === "applied") return; // guard double-submit
    setProposalStatus((s) => ({ ...s, [p.id]: "applying" }));
    try {
      await executeProposal(p.id);
      setProposalStatus((s) => ({ ...s, [p.id]: "applied" }));
    } catch (e) {
      setProposalStatus((s) => ({ ...s, [p.id]: "error" }));
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  /** Bulk flows (e.g. "link all my lectures"): approve every still-pending
   * proposal on a message, sequentially so each lands (and ledgers) cleanly. */
  const approveAll = async (ps: ToolProposal[]) => {
    for (const p of ps) {
      const st = proposalStatus[p.id];
      if (!st || st === "error") await approveProposal(p);
    }
  };

  const dismissProposal = (id: number) => {
    setProposalStatus((s) => ({ ...s, [id]: "dismissed" }));
    // Consume it server-side too (ledgered as rejected). Best-effort: if the
    // call fails the proposal just expires unused, same as before.
    void rejectProposal(id).catch(() => {});
  };

  const activeProjectName = activeChat ? active.find((p) => p.id === activeChat.projectId)?.name : undefined;

  // Who actually answers in THIS chat: the project's configured personality if
  // set, else the globally-active one — mirroring the server's resolution, so
  // the banner always matches the voice.
  const projectProfileId = activeChat ? projects.find((p) => p.id === activeChat.projectId)?.model_profile_id ?? null : null;
  const assistant = profiles.find((p) => p.id === (projectProfileId ?? activeProfileId)) ?? null;
  const isProjectPersonality = projectProfileId != null && assistant?.id === projectProfileId;

  // The open chat's author (writes all its user messages) → their avatar/name.
  const activeChatObj = activeChat?.chatId != null
    ? (chatsByProject[activeChat.projectId] ?? []).find((c) => c.id === activeChat.chatId)
    : undefined;
  // For message avatars, prefer the personality this chat was answered by
  // (its stored profile_id) over the globally-active one, so a historical
  // thread keeps the right face even after the active personality changes.
  const chatAssistant = profiles.find((p) => p.id === activeChatObj?.profile_id) ?? assistant;
  const authorId = activeChatObj?.user_id ?? null;
  useEffect(() => {
    if (authorId == null || userById[authorId]) return;
    getUser(authorId)
      .then((u) => setUserById((m) => ({ ...m, [authorId]: { avatar: parseProfile(u.profile_json).avatar, name: u.full_name } })))
      .catch(() => {/* author not resolvable — fall back to initials */});
  }, [authorId, userById]);
  const author = authorId != null ? userById[authorId] : undefined;

  const explorer = (
    <div className="flex-1 min-w-0 h-full flex bg-base text-text">
      {ctxMenu.element}
      {/* LEFT: chat list — grouped by project, styled like the Tasks rail */}
      <div className={`${ASSISTANT_TREE_W} shrink-0 border-r border-gilt-b bg-crust flex flex-col min-h-0`}>
        <div className="px-3 py-2.5 border-b border-gilt-b">
          <span className="g-deco text-[11px] font-semibold text-gold">Chats</span>
        </div>
        <div className="flex-1 overflow-y-auto p-2 space-y-1.5">
          {active.length === 0 && <p className="px-2 py-2 text-sm text-[color:var(--g-mut)] italic">No projects yet.</p>}
          {active.map((p) => {
            const isOpen = openProject === p.id;
            const chats = chatsByProject[p.id] ?? [];
            return (
              <div key={p.id}>
                {/* Project = group header (Tasks-rail style) */}
                <button onClick={() => toggleProject(p.id)} className="w-full flex items-center gap-1.5 min-h-8 px-1 mb-0.5 text-left group">
                  <svg className={`w-3 h-3 text-[color:var(--g-mut)] transition-transform shrink-0 ${isOpen ? "rotate-90" : ""}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                  </svg>
                  <span className="g-deco text-[11px] font-semibold tracking-[0.22em] text-[color:var(--g-mut)] group-hover:text-[color:var(--g-fg2)] truncate flex-1">{p.name}</span>
                  {chats.length > 0 && <span className="text-[11px] text-[color:var(--g-mut)] tabular-nums shrink-0">{chats.length}</span>}
                </button>
                {isOpen && (
                  <div className="space-y-0.5 mb-1.5">
                    <button onClick={() => newChat(p.id)} className="w-full text-left min-h-8 px-2.5 text-xs font-semibold text-gold hover:bg-gilt-b rounded">
                      + New chat
                    </button>
                    {chats.length === 0 && <div className="px-2.5 py-1 text-xs text-subtext-0 italic">No chats yet</div>}
                    {chats.map((c) => {
                      const sel = activeChat?.chatId === c.id;
                      return (
                      <div key={c.id} className="group/chat relative">
                        <button
                          onClick={() => openChat(p.id, c.id)}
                          onContextMenu={(e) => ctxMenu.open(e, [
                            { label: "Open", icon: "↗", onClick: () => void openChat(p.id, c.id) },
                            { label: c.pinned ? "Unpin" : "Pin to top", icon: <PinGlyph className="block w-4 h-4" />, onClick: () => void pinThisChat(p.id, c) },
                            { label: "Move to bin", icon: "🗑", danger: true, divider: true, onClick: () => void binThisChat(p.id, c) },
                          ])}
                          title={c.title ?? "Untitled chat"}
                          aria-current={sel ? "true" : undefined}
                          className={`w-full text-left px-3 py-2.5 rounded ${
                            sel ? "g-sel" : "hover:bg-surface-0"
                          }`}
                        >
                          <div className="flex items-start gap-1.5">
                            {c.pinned && (
                              <svg className="w-3 h-3 text-gold shrink-0 mt-0.5" fill="currentColor" viewBox="0 0 24 24">
                                <path d="M16 12V4H17V2H7V4H8V12L6 14V16H11.2V22H12.8V16H18V14L16 12Z" />
                              </svg>
                            )}
                            <span className="text-sm font-medium text-text break-words line-clamp-2 flex-1">{c.title ?? "Untitled chat"}</span>
                          </div>
                          <div className="mt-1 flex items-center gap-1.5 text-[11px] text-[color:var(--g-mut)]">
                            <span className="truncate">{relTime(c.updated_at)}</span>
                            {c.is_public && (
                              <span className="shrink-0" title={isMine(c) ? "Shared with the team" : "Shared by a teammate"}>
                                · {isMine(c) ? "🌐 shared" : "👥 shared"}
                              </span>
                            )}
                          </div>
                        </button>
                        {isMine(c) && (
                          <div className="absolute right-1 top-1 flex gap-0.5">
                            <button
                              onClick={() => void pinThisChat(p.id, c)}
                              title={c.pinned ? "Unpin" : "Pin to top"}
                              className={`g-iconbtn !w-8 !h-8 ${c.pinned ? "!text-gold" : "hover:!text-gold opacity-0 group-hover/chat:opacity-100 focus-visible:opacity-100"}`}
                            >
                              <svg className="w-3.5 h-3.5" fill={c.pinned ? "currentColor" : "none"} stroke="currentColor" strokeWidth={c.pinned ? 0 : 2} viewBox="0 0 24 24">
                                <path d="M16 12V4H17V2H7V4H8V12L6 14V16H11.2V22H12.8V16H18V14L16 12Z" />
                              </svg>
                            </button>
                            <button
                              onClick={() => void binThisChat(p.id, c)}
                              title="Move to bin (restorable)"
                              className="g-iconbtn !w-8 !h-8 hover:!text-error opacity-0 group-hover/chat:opacity-100 focus-visible:opacity-100"
                            >
                              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                              </svg>
                            </button>
                          </div>
                        )}
                      </div>
                      );
                    })}
                    <button
                      onClick={() => {
                        const open = !binOpen[p.id];
                        setBinOpen((b) => ({ ...b, [p.id]: open }));
                        if (open) void loadBinned(p.id);
                      }}
                      className="w-full text-left min-h-8 px-2.5 text-xs text-[color:var(--g-mut)] hover:bg-surface-0 hover:text-text rounded"
                    >
                      {binOpen[p.id] ? "▾" : "▸"} Bin
                    </button>
                    {binOpen[p.id] &&
                      ((binnedByProject[p.id] ?? []).length === 0 ? (
                        <div className="px-2.5 py-1 text-xs text-[color:var(--g-mut)] italic">Bin is empty</div>
                      ) : (
                        (binnedByProject[p.id] ?? []).map((c) => (
                          <div key={c.id} className="flex items-center gap-1 px-2.5 py-1 text-xs text-[color:var(--g-mut)]">
                            <span className="truncate flex-1" title={c.title ?? "Untitled chat"}>{c.title ?? "Untitled chat"}</span>
                            <button onClick={() => void restoreThisChat(p.id, c)} title="Restore" className="g-lnk shrink-0 min-h-8 px-1">Restore</button>
                            <button onClick={() => void purgeThisChat(p.id, c)} title="Delete forever" className="g-iconbtn !w-8 !h-8 shrink-0 hover:!text-error">✕</button>
                          </div>
                        ))
                      ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* RIGHT: active conversation */}
      <div className="flex-1 flex flex-col min-w-0 bg-mantle">
        {!connected ? (
          <div className="flex-1 flex items-center justify-center p-8">
            <div className="max-w-md text-center text-sm text-[color:var(--g-fg2)]">
              <p className="text-text font-medium mb-1">Not connected to a host</p>
              <p>The assistant runs on the host. Start it under <span className="text-text">Settings → AI Engines → Start engines</span>, or connect under <span className="text-text">Settings → Sync</span>.</p>
            </div>
          </div>
        ) : !activeChat ? (
          <div className="flex-1 flex items-center justify-center p-8">
            <p className="max-w-md text-center text-sm text-[color:var(--g-fg2)]">
              Pick a project folder on the left and start a chat. The assistant answers from that project's tasks, events, notes and files.
            </p>
          </div>
        ) : (
          <div className="flex-1 min-h-0 flex">
            <div className="flex-1 min-w-0 flex flex-col">
            <div className="px-5 py-3 border-b border-gilt-b bg-base flex items-center justify-between gap-3">
              <div className="flex items-center gap-2.5 min-w-0">
                <AssistantAvatar profile={assistant} size={34} />
                <div className="min-w-0">
                  <div className="text-[15px] font-semibold truncate">
                    {assistant?.name ?? activeProjectName ?? "Assistant"}
                    {assistant && <span className="ml-1.5 text-xs font-normal text-subtext-0 font-mono">{assistant.model}</span>}
                    {isProjectPersonality && (
                      <span className="g-tag g-tag-pri ml-1.5 min-h-[20px] px-2 text-[10px] align-middle">
                        project personality
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-[color:var(--g-mut)]">
                    {readOnly
                      ? "Shared by a teammate — read-only"
                      : `${activeProjectName ?? "This project"} · grounded in its tasks, events, notes & files`}
                  </div>
                </div>
              </div>
              {activeChatMeta && !readOnly && (
                <button
                  onClick={togglePublic}
                  title={activeChatMeta.is_public ? "Make private again" : "Let the whole team read this chat"}
                  className={`g-btn g-btn-sm shrink-0 ${activeChatMeta.is_public ? "g-btn-gilt" : "g-btn-ghost"}`}
                >
                  {activeChatMeta.is_public ? "🌐 Shared" : "Share with team"}
                </button>
              )}
            </div>
            <div ref={scrollRef} className="flex-1 overflow-y-auto px-5 py-5 space-y-4">
              {messages.length === 0 && (
                <div className="text-center text-[color:var(--g-mut)] text-sm mt-10">Ask anything about this project.</div>
              )}
              {messages.map((m, i) => {
                const isLast = i === messages.length - 1;
                const streaming = m.role === "assistant" && isLast && sending && !m.content;
                return (
                <div key={i} className={`${THREAD_COL} flex items-end gap-2.5 ${m.role === "user" ? "justify-end" : "justify-start"}`}>
                  {m.role !== "user" && (
                    <div className="shrink-0 mb-0.5" title={chatAssistant?.name ?? "Assistant"}>
                      <AssistantAvatar profile={chatAssistant} size={28} />
                    </div>
                  )}
                  <div className={`min-w-0 px-4 py-3 max-w-[min(85%,80ch)] text-sm leading-relaxed ${m.role === "user" ? "rounded-xl rounded-br-sm bg-primary/15 border border-primary/25 text-text whitespace-pre-wrap break-words" : "g-plain rounded-xl rounded-bl-sm"}`}>
                    {m.content
                      ? (m.role === "user" ? m.content : <MarkdownPreview content={m.content} />)
                      : streaming
                        ? <StreamStatus {...(streamPhase ?? { phase: "retrieving" })} />
                        : ""}
                    {m.role !== "user" && (m.usage || (isLast && sending && liveTokps != null)) && (
                      <div className="text-[10px] text-[color:var(--g-mut)] mt-1.5 flex items-center gap-1 tabular-nums" title="Generation speed (server-measured)">
                        <span>⚡</span>
                        {m.usage
                          ? <span>{fmtTokps(m.usage)} tok/s · {m.usage.completion_tokens} tokens</span>
                          : <span>~{Math.round(liveTokps!)} tok/s</span>}
                      </div>
                    )}
                    {m.tools && m.tools.length > 0 && (
                      <div className="mt-2 pt-2 border-t border-surface-1">
                        <div className="text-[10px] text-[color:var(--g-mut)] mb-1">🔧 Looked up</div>
                        <div className="flex flex-wrap gap-1">
                          {m.tools.map((t, k) => (
                            <span key={k} className="g-tag !min-h-[20px] !px-2 !text-[10px]">{t}</span>
                          ))}
                        </div>
                      </div>
                    )}
                    {m.sources && m.sources.length > 0 && <SourcesCard sources={m.sources} />}
                    {m.proposals && m.proposals.length > 0 && (
                      <div className="mt-2 pt-2 border-t border-surface-1 space-y-1.5">
                        <div className="flex items-center justify-between gap-2">
                          <div className="g-deco text-[10px] font-semibold text-gold">Proposed changes — approve to apply</div>
                          {m.proposals.filter((p) => !proposalStatus[p.id]).length >= 3 && (
                            <button
                              onClick={() => void approveAll(m.proposals!)}
                              className="g-btn g-btn-pri g-btn-sm shrink-0"
                            >
                              Approve all ({m.proposals.filter((p) => !proposalStatus[p.id]).length})
                            </button>
                          )}
                        </div>
                        {m.proposals.map((p) => {
                          const st = proposalStatus[p.id];
                          return (
                            <div key={p.id} className="flex items-center gap-2 text-xs">
                              <span className="flex-1 text-text">{p.summary}</span>
                              {st === "applying" ? (
                                <span className="text-[color:var(--g-mut)] shrink-0">applying…</span>
                              ) : st === "applied" ? (
                                <span className="g-tag g-tag-ok !min-h-[22px] !px-2 !text-[11px] shrink-0">✓ applied</span>
                              ) : st === "dismissed" ? (
                                <span className="text-[color:var(--g-mut)] shrink-0">dismissed</span>
                              ) : st === "error" ? (
                                <button onClick={() => approveProposal(p)} className="g-btn g-btn-danger g-btn-sm shrink-0">retry</button>
                              ) : (
                                <span className="flex gap-1 shrink-0">
                                  <button onClick={() => approveProposal(p)} className="g-btn g-btn-pri g-btn-sm">Approve</button>
                                  <button onClick={() => dismissProposal(p.id)} className="g-btn g-btn-ghost g-btn-sm">Dismiss</button>
                                </span>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                  {m.role === "user" && (
                    <div className="shrink-0 mb-0.5" title={author?.name ?? "You"}>
                      <ProfileAvatar avatar={author?.avatar} name={author?.name ?? "You"} size={28} />
                    </div>
                  )}
                </div>
                );
              })}
              {error && <div className={`${THREAD_COL} text-sm text-error bg-error/10 border border-error/30 rounded px-3 py-2`}>{error}</div>}
            </div>
            <div className="px-5 pt-2 pb-5">
              {readOnly ? (
                <div className={`${THREAD_COL} g-plain px-4 py-3 text-center text-xs text-[color:var(--g-mut)]`}>
                  This is a teammate's shared chat. You can read it, but only the author can continue it.
                </div>
              ) : (
                <div className={`${THREAD_COL} g-card px-4 pt-3.5 pb-3.5`}>
                  {profiles.length > 1 && (
                    <div className="flex items-center gap-1.5 flex-wrap mb-2 text-xs">
                      <span className="text-[color:var(--g-mut)]">Tag an agent:</span>
                      {profiles.map((p) => (
                        <button
                          key={p.id}
                          onClick={() => {
                            setInput((v) => `${v}${v && !v.endsWith(" ") ? " " : ""}@${p.name} `);
                            inputRef.current?.focus();
                          }}
                          className="g-tag min-h-8 hover:bg-surface-1 hover:text-text"
                        >
                          @{p.name}
                        </button>
                      ))}
                    </div>
                  )}
                  <div className="flex items-center gap-2 mb-2 text-xs">
                    <button
                      onClick={() => setUseTools((v) => !v)}
                      title="Let the assistant look up this project's data, and propose changes (tasks, comments) for you to approve"
                      className={`g-tag min-h-8 transition-colors ${
                        useTools ? "!text-gold !bg-gilt-b shadow-[inset_0_0_0_1px_var(--color-gilt-a)]" : "hover:bg-surface-1 hover:text-text"
                      }`}
                    >
                      🔧 Tools {useTools ? "on" : "off"}
                    </button>
                    {useTools && <span className="text-[color:var(--g-mut)]">The assistant can look up this project's data.</span>}
                  </div>
                  <div className="flex gap-2 items-end">
                  <textarea
                    ref={inputRef}
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        send();
                      }
                    }}
                    rows={1}
                    placeholder="Message the assistant… (@name to ask a specific agent)"
                    disabled={sending}
                    className="g-field flex-1 resize-none"
                  />
                  <button
                    onClick={send}
                    disabled={sending || !input.trim()}
                    className="g-btn g-btn-pri"
                  >
                    {sending ? "…" : "Send"}
                  </button>
                  </div>
                </div>
              )}
            </div>
            </div>
            <AssistantPanel
              assistant={assistant}
              isProjectPersonality={isProjectPersonality}
              profiles={profiles}
              messages={messages}
              useTools={useTools}
              onMention={(name) => {
                setInput((v) => (v === "" || v.endsWith(" ") ? v : v + " ") + `@${name} `);
                inputRef.current?.focus();
              }}
            />
          </div>
        )}
      </div>
    </div>
  );

  // Embedded in a project's Chats tab → just the conversation explorer.
  if (scopeProjectId != null) return explorer;

  // Top-level Assistant → a tabbed hub: Chats · Indexing · Models.
  return (
    <div className="h-full flex flex-col bg-mantle text-text">
      <header className="shrink-0 bg-mantle border-b border-gilt-b px-8 pt-6">
        <h1 className="g-ptitle text-text">Assistant</h1>
        <nav className="mt-3 -mx-4 flex items-center overflow-x-auto">
        {ASSISTANT_TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            aria-current={tab === t.id ? "page" : undefined}
            className={`min-h-[42px] px-4 inline-flex items-center whitespace-nowrap text-sm font-medium transition-colors shrink-0 ${
              tab === t.id ? "text-gold shadow-[inset_0_-2px_0_var(--color-gold)]" : "text-[color:var(--g-fg2)] hover:text-text"
            }`}
          >
            <TabIcon name={t.icon} className="w-4 h-4 mr-2" />
            {t.label}
          </button>
        ))}
        </nav>
      </header>
      <div className="flex-1 min-h-0 flex flex-col">
        {tab === "chats" && explorer}
        {tab === "corpus" && <CorpusLensPanel />}
        {tab === "indexing" && <IndexingPanel />}
        {tab === "tools" && (
          <div className="flex-1 min-h-0">
            <ToolsPanel />
          </div>
        )}
        {tab === "models" && (
          <div className="flex-1 min-h-0">
            <ModelProfilesPanel />
          </div>
        )}
        {tab === "oracle" && (
          <div className="flex-1 min-h-0">
            <OraclePanel />
          </div>
        )}
        {tab === "bridge" && (
          <div className="flex-1 min-h-0">
            <BridgePanel />
          </div>
        )}
        {tab === "activity" && (
          <div className="flex-1 min-h-0">
            <ActivityView />
          </div>
        )}
      </div>
    </div>
  );
}

/** Right-hand assistant panel: WHO answers here (the personality's vCard),
 * who else can be @mentioned (tap to address them), and what this conversation
 * has been grounded in. Fills the dead space on wide screens; hidden below xl. */
function AssistantPanel({
  assistant,
  isProjectPersonality,
  profiles,
  messages,
  useTools,
  onMention,
}: {
  assistant: ModelProfile | null;
  isProjectPersonality: boolean;
  profiles: ModelProfile[];
  messages: Msg[];
  useTools: boolean;
  onMention: (name: string) => void;
}) {
  // Aggregate the conversation's citations: source → times referenced.
  const counts = new Map<string, { label: string; n: number }>();
  for (const m of messages) {
    for (const src of m.sources ?? []) {
      const cur = counts.get(src.source) ?? { label: sourceLabel(src), n: 0 };
      cur.n += 1;
      counts.set(src.source, cur);
    }
  }
  const grounding = [...counts.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 8);
  const others = profiles.filter((p) => p.id !== assistant?.id);

  return (
    <div className="hidden xl:flex w-72 shrink-0 border-l border-gilt-b bg-crust flex-col overflow-y-auto">
      <div className="p-4 border-b border-gilt-b">
        <div className="flex items-center gap-3">
          <AssistantAvatar profile={assistant} size={48} />
          <div className="min-w-0">
            <div className="text-[15px] font-semibold text-text truncate">{assistant?.name ?? "Assistant"}</div>
            {assistant && <div className="text-xs text-[color:var(--g-mut)] font-mono truncate">{assistant.model}</div>}
            <span className="g-tag g-tag-pri mt-1 min-h-[20px] px-2 text-[10px]">
              {isProjectPersonality ? "project personality" : "active personality"}
            </span>
          </div>
        </div>
        {assistant?.model_meta && (
          <div className="mt-3">
            <ModelCard meta={parseModelMeta(assistant.model_meta)} />
          </div>
        )}
        <p className="mt-3 text-[11px] text-[color:var(--g-mut)]">
          Tools {useTools ? "on — it can read this project's data and propose gated changes" : "off — answers from the conversation and the knowledge base only"}.
        </p>
      </div>

      {others.length > 0 && (
        <div className="p-4 border-b border-gilt-b">
          <div className="g-deco text-[10px] font-semibold text-gold mb-2">
            Also available — tap to address
          </div>
          <div className="space-y-1">
            {others.map((p) => (
              <button
                key={p.id}
                onClick={() => onMention(p.name)}
                title={`Insert @${p.name} — routes your next message to this personality`}
                className="w-full flex items-center gap-2 min-h-8 px-2 py-1.5 rounded hover:bg-surface-0 text-left"
              >
                <AssistantAvatar profile={p} size={24} />
                <span className="min-w-0">
                  <span className="block text-xs text-text truncate">{p.name}</span>
                  <span className="block text-[10px] text-[color:var(--g-mut)] font-mono truncate">{p.model}</span>
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="p-4">
        <div className="g-deco text-[10px] font-semibold text-gold mb-2">
          Grounded in (this conversation)
        </div>
        {grounding.length === 0 ? (
          <p className="text-[11px] text-[color:var(--g-mut)] italic">
            No citations yet — answers will list the project notes, tasks and files they drew on.
          </p>
        ) : (
          <div className="space-y-1">
            {grounding.map(([source, { label, n }]) => (
              <div key={source} className="flex items-center justify-between gap-2 text-[11px]">
                <span className="text-[color:var(--g-fg2)] truncate" title={source}>
                  {label}: {source}
                </span>
                <span className="text-[color:var(--g-mut)] tabular-nums shrink-0">×{n}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
