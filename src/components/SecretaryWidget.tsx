import { useState, useEffect, useRef } from "react";
import { Card, DecoHeading } from "./gilt";
import { loadSecretaryThread, saveSecretaryThread, clearSecretaryThread } from "../lib/secretaryThread";
import {
  getDailyBrief,
  getLatestRundown,
  generateRundown,
  streamSecretary,
  type DailyBrief,
  type EventBrief,
  type Rundown,
} from "../lib/daemon";

interface Msg {
  role: "user" | "assistant";
  content: string;
}

const flagStyle: Record<string, string> = {
  due_soon: "g-tag-warn",
  blocked: "g-tag-red",
  stalled: "g-tag-red",
  on_track: "g-tag-ok",
};
const MUTED = "text-[color:var(--g-mut)]";
/** A small deco label over a group of rows. */
const GROUP = "g-deco text-[11px] font-semibold text-[color:var(--g-mut)] mt-3 mb-1";

/** A short, friendly date from a YYYY-MM-DD string (parsed as local midnight). */
function prettyDate(ymd: string): string {
  const d = new Date(`${ymd}T00:00:00`);
  if (isNaN(d.getTime())) return ymd;
  return d.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });
}

function eventTime(e: EventBrief): string {
  if (e.all_day) return "All day";
  if (e.start_time && e.end_time) return `${e.start_time}–${e.end_time}`;
  return e.start_time || "";
}

/** One event row in the brief. For events beyond tomorrow, `showDate` puts the
 * weekday/day in the lead column (instead of just the time) so multi-day
 * "this week" rows are legible. */
function EventLine({ e, showDate }: { e: EventBrief; showDate?: boolean }) {
  return (
    <div className="flex items-baseline gap-3 min-h-[34px] py-1 border-t border-gilt-b">
      <span className="g-deco shrink-0 w-28 text-gold tabular-nums tracking-[.08em] text-[13px]">
        {showDate ? `${e.weekday} ${Number(e.date.slice(8))}` : eventTime(e)}
      </span>
      <span className="text-text font-medium truncate">
        {showDate && !e.all_day && e.start_time && <span className={`font-normal ${MUTED}`}>{e.start_time} </span>}
        {e.title}
      </span>
      {e.location && <span className={`text-[13px] truncate ${MUTED}`}>· {e.location}</span>}
      {e.projects.length > 0 && (
        <span className={`text-[13px] truncate ${MUTED}`}>· {e.projects.join(", ")}</span>
      )}
    </div>
  );
}

/**
 * The "secretary" — a grounded, cross-project daily assistant on the Home page.
 * Owner-only (the server gates every route on owner/loopback). Shows the day's
 * events (deterministic facts), a per-project daily rundown, and an ephemeral
 * grounded chat. The conversation lives only in this component's state.
 */
export default function SecretaryWidget() {
  const [brief, setBrief] = useState<DailyBrief | null>(null);
  const [rundown, setRundown] = useState<Rundown | null>(null);
  const [rundownOpen, setRundownOpen] = useState(false);
  const [generating, setGenerating] = useState(false);
  // The thread survives navigation and restarts (the endpoint is stateless;
  // the client owns the history — losing it per page-switch was the bug).
  const [messages, setMessages] = useState<Msg[]>(() => loadSecretaryThread());
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  const threadRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    mounted.current = true;
    getDailyBrief()
      .then((b) => mounted.current && setBrief(b))
      .catch(() => {});
    getLatestRundown()
      .then((r) => mounted.current && setRundown(r))
      .catch(() => {});
    return () => {
      mounted.current = false;
    };
  }, []);

  // Keep the thread scrolled to the latest as tokens stream in.
  useEffect(() => {
    threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight });
  }, [messages]);

  const today = brief?.events.filter((e) => e.bucket === "today") ?? [];
  const tomorrow = brief?.events.filter((e) => e.bucket === "tomorrow") ?? [];
  const upcoming = brief?.events.filter((e) => e.bucket === "upcoming") ?? [];
  const rundownStale = rundown != null && brief != null && rundown.run_date !== brief.today;

  // Persist the thread (debounce-free: writes are tiny and infrequent).
  useEffect(() => {
    saveSecretaryThread(messages);
  }, [messages]);

  async function send() {
    const q = input.trim();
    if (!q || streaming) return;
    setInput("");
    setError(null);
    const history = messages.map((m) => ({ role: m.role, content: m.content }));
    setMessages((m) => [...m, { role: "user", content: q }, { role: "assistant", content: "" }]);
    setStreaming(true);
    try {
      await streamSecretary(
        { message: q, history },
        {
          onToken: (d) =>
            setMessages((m) => {
              const c = [...m];
              const last = c[c.length - 1];
              if (last && last.role === "assistant") c[c.length - 1] = { ...last, content: last.content + d };
              return c;
            }),
          onError: (e) => setError(e),
        }
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (mounted.current) {
        setStreaming(false);
        // Drop the placeholder bubble if the turn failed before any token arrived.
        setMessages((m) => {
          const last = m[m.length - 1];
          return last && last.role === "assistant" && last.content === "" ? m.slice(0, -1) : m;
        });
      }
    }
  }

  async function refreshRundown() {
    if (generating) return;
    setGenerating(true);
    setError(null);
    try {
      const r = await generateRundown();
      if (!mounted.current) return;
      setRundown(r);
      setRundownOpen(true);
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (mounted.current) setGenerating(false);
    }
  }

  return (
    <Card as="section" corners className="px-[30px] pt-6 pb-5" aria-label="Secretary">
      <DecoHeading className="!mb-1">Secretary</DecoHeading>
      {brief && (
        <p className={`text-center text-[13px] mb-4 ${MUTED}`}>
          {prettyDate(brief.today)} · {brief.now}
        </p>
      )}

      {/* The readable column: running text keeps its line length on any width. */}
      <div className={`mx-auto max-w-[720px] ${brief ? "" : "mt-4"}`}>
        {/* Today's agenda (deterministic facts) */}
        <div>
          {!brief ? (
            <p className={`text-center ${MUTED}`}>Loading your day…</p>
          ) : brief.events.length === 0 ? (
            <p className={`text-center ${MUTED}`}>Nothing scheduled in the next 7 days.</p>
          ) : (
            <>
              {today.length > 0 ? (
                today.map((e) => <EventLine key={e.id} e={e} />)
              ) : (
                <p className={`text-center ${MUTED}`}>Nothing scheduled today.</p>
              )}
              {tomorrow.length > 0 && (
                <div>
                  <div className={GROUP}>Tomorrow</div>
                  {tomorrow.map((e) => (
                    <EventLine key={e.id} e={e} />
                  ))}
                </div>
              )}
              {upcoming.length > 0 && (
                <div>
                  <div className={GROUP}>This week</div>
                  {upcoming.map((e) => (
                    <EventLine key={e.id} e={e} showDate />
                  ))}
                </div>
              )}
            </>
          )}
        </div>

        {/* Conversation */}
        {messages.length > 0 && (
          <div ref={threadRef} className="mt-4 max-h-56 overflow-y-auto space-y-2 border-t border-gilt-b pt-2">
            {messages.length > 0 && (
              <div className="text-right">
                <button
                  onClick={() => { setMessages([]); clearSecretaryThread(); }}
                  className={`text-xs hover:text-text underline decoration-dotted ${MUTED}`}
                  title="Forget this conversation (the server keeps no copy)"
                >
                  clear conversation
                </button>
              </div>
            )}
            {messages.map((m, i) => (
              <div key={i} className={m.role === "user" ? "text-right" : "text-left"}>
                <div
                  className={`inline-block max-w-[85%] text-left rounded px-3 py-1.5 text-sm whitespace-pre-wrap ${
                    m.role === "user" ? "bg-primary text-primary-text" : "bg-surface-0 text-text"
                  }`}
                >
                  {m.content || (streaming && i === messages.length - 1 ? "…" : "")}
                </div>
              </div>
            ))}
          </div>
        )}

        {error && <p className="mt-3 text-xs text-error text-center">{error}</p>}

        {/* Ask box */}
        <div className="mt-5 flex items-center gap-2">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            aria-label="Ask the Secretary"
            placeholder="Ask about your day… (e.g. what do I need for my 1pm?)"
            className="g-field flex-1 min-w-0"
          />
          <button
            onClick={() => void send()}
            disabled={streaming || !input.trim()}
            className="g-btn g-btn-pri g-glint"
          >
            {streaming ? "…" : "Ask"}
          </button>
        </div>

        <div className="mt-2.5 text-center">
          <button onClick={() => setRundownOpen((o) => !o)} className="g-lnk text-[13px] min-h-[32px]">
            {rundownOpen ? "Hide rundown" : "Daily rundown"}
          </button>
        </div>

        {/* Daily rundown (per-project digest) */}
        {rundownOpen && (
          <div className="mt-2 rounded border border-gilt-b bg-mantle px-4 py-3 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <span className={`g-deco text-[11px] font-semibold ${MUTED}`}>
                Daily rundown
                {rundown && ` · ${rundownStale ? `from ${rundown.run_date}` : "today"}`}
              </span>
              <button onClick={refreshRundown} disabled={generating} className="g-btn g-btn-ghost g-btn-sm">
                {generating ? "Generating…" : rundown ? "Refresh" : "Generate"}
              </button>
            </div>
            {!rundown ? (
              <p className={MUTED}>
                {generating ? "Summarizing each project…" : "No rundown yet — generate today's digest."}
              </p>
            ) : rundown.projects.length === 0 ? (
              <p className={MUTED}>No active projects to summarize.</p>
            ) : (
              <div className="space-y-3">
                {rundown.projects.map((p) => (
                  <div key={p.project_id}>
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-semibold text-text">{p.project_name}</span>
                      {p.flags.map((f) => (
                        <span key={f} className={`g-tag ${flagStyle[f] ?? ""}`}>
                          {f.replace(/_/g, " ")}
                        </span>
                      ))}
                    </div>
                    <p className="text-sm text-[color:var(--g-fg2)]">{p.summary}</p>
                  </div>
                ))}
                {rundown.omitted > 0 && (
                  <p className={`text-xs ${MUTED}`}>+{rundown.omitted} more project(s) not summarized this run.</p>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}
