import { useCallback, useEffect, useMemo, useState } from "react";
import {
  listProjectEmailThreads,
  listUnlinkedEmailThreads,
  linkEmailThread,
  listEmailThreadMessages,
  DaemonError,
  type EmailThread,
  type EmailMessage,
} from "../lib/daemon";

const dateLabel = (iso: string) => {
  const d = new Date(iso);
  return isNaN(d.getTime())
    ? iso
    : d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
};

const subjectOf = (t: { subject: string }) => t.subject.trim() || "(no subject)";

/**
 * Email — this project's linked mail threads. Any member reads what's been
 * linked here; every member ALSO gets a browser of still-unlinked threads from
 * their OWN mailboxes (connected under Settings → Plug-ins) to link in, and
 * may unlink the threads they own. Bodies fetch host-side shortly after
 * linking. Nobody ever sees another member's unlinked mail.
 */
export default function EmailTab({ projectId }: { projectId: number }) {
  const [linked, setLinked] = useState<EmailThread[]>([]);
  const [linkedError, setLinkedError] = useState<string | null>(null);
  // null = not loaded yet; the list only ever contains the CALLER's threads.
  const [unlinked, setUnlinked] = useState<EmailThread[] | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [messages, setMessages] = useState<EmailMessage[]>([]);
  const [msgError, setMsgError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const hasBrowser = unlinked !== null;
  const selected = linked.find((t) => t.id === selectedId) ?? null;

  const refreshLinked = useCallback(async () => {
    try {
      setLinked(await listProjectEmailThreads(projectId));
      setLinkedError(null);
    } catch (e) {
      setLinkedError(e instanceof Error ? e.message : String(e));
    }
  }, [projectId]);

  const refreshUnlinked = useCallback(async () => {
    try {
      setUnlinked(await listUnlinkedEmailThreads());
    } catch {
      // The route returns the CALLER's own mailbox threads (members included);
      // on any failure there's simply nothing to link from — hide the section.
      setUnlinked(null);
    }
  }, []);

  useEffect(() => {
    setSelectedId(null);
    setMessages([]);
    setMsgError(null);
    void refreshLinked();
    void refreshUnlinked();
  }, [refreshLinked, refreshUnlinked]);

  const loadMessages = useCallback(async (threadId: number) => {
    setMsgError(null);
    try {
      setMessages(await listEmailThreadMessages(threadId));
    } catch (e) {
      // E.g. the thread was just unlinked elsewhere — membership no longer
      // grants its messages (403). Surface it inline.
      setMessages([]);
      setMsgError(e instanceof DaemonError ? e.message : e instanceof Error ? e.message : String(e));
    }
  }, []);

  const selectThread = (t: EmailThread) => {
    setSelectedId(t.id);
    setMessages([]);
    void loadMessages(t.id);
  };

  const link = async (t: EmailThread) => {
    setBusy(true);
    try {
      await linkEmailThread(t.id, projectId);
      await Promise.all([refreshLinked(), refreshUnlinked()]);
      setSelectedId(t.id);
      setMessages([]);
      void loadMessages(t.id);
    } catch (e) {
      setLinkedError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const unlink = async (t: EmailThread) => {
    setBusy(true);
    try {
      await linkEmailThread(t.id, null);
      setSelectedId(null);
      setMessages([]);
      setMsgError(null);
      await Promise.all([refreshLinked(), refreshUnlinked()]);
    } catch (e) {
      setMsgError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  // Oldest-first cards (envelope date; undated messages keep arrival order last).
  const orderedMessages = useMemo(() => {
    return [...messages].sort((a, b) => {
      const ta = a.date ? Date.parse(a.date) : Number.POSITIVE_INFINITY;
      const tb = b.date ? Date.parse(b.date) : Number.POSITIVE_INFINITY;
      return ta === tb ? a.id - b.id : ta - tb;
    });
  }, [messages]);

  return (
    <div className="flex-1 min-w-0 min-h-0 flex flex-col overflow-hidden bg-base text-text">
      {/* Stacks on phone widths (the 320px sidebar would leave no room). */}
      <div className="flex-1 min-h-0 flex flex-col sm:flex-row">
        {/* LEFT: linked threads + the unlinked-thread browser */}
        <div className="w-full max-h-[45%] sm:max-h-none sm:w-80 shrink-0 border-b sm:border-b-0 sm:border-r border-gilt-a flex flex-col min-h-0 bg-mantle">
          <div className="flex-1 overflow-y-auto p-3 space-y-4">
            <section className="space-y-2">
              <span className="g-cap block">
                Linked threads
              </span>
              {linkedError && (
                <div className="text-sm text-error bg-error/10 border border-error/30 rounded-lg px-3 py-2">
                  {linkedError}
                </div>
              )}
              {linked.length === 0 && !linkedError && (
                <p className="text-sm text-subtext-0 italic">
                  No email threads linked to this project yet
                  {hasBrowser ? " — link one below." : "."}
                </p>
              )}
              {linked.map((t) => (
                <button
                  key={t.id}
                  onClick={() => selectThread(t)}
                  className={`g-row w-full text-left !block !py-2 ${selectedId === t.id ? "g-sel" : ""}`}
                >
                  <div className="text-sm text-text truncate" title={subjectOf(t)}>
                    {subjectOf(t)}
                  </div>
                  <div className="text-xs text-subtext-0">
                    {t.message_count} message{t.message_count !== 1 ? "s" : ""}
                    {t.last_date ? ` · ${dateLabel(t.last_date)}` : ""}
                  </div>
                </button>
              ))}
            </section>

            {/* Owner-only: still-unlinked threads from the synced mailboxes */}
            {unlinked !== null && (
              <section className="space-y-2">
                <span className="g-cap block">
                  Link a thread
                </span>
                {unlinked.length === 0 && (
                  <p className="text-sm text-subtext-0 italic">
                    No unlinked threads — sync an email account under Settings → Plug-ins.
                  </p>
                )}
                {unlinked.map((t) => (
                  <div
                    key={t.id}
                    className="g-frow !gap-2 !px-3"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="text-sm text-text truncate" title={subjectOf(t)}>
                        {subjectOf(t)}
                      </div>
                      <div className="text-xs text-subtext-0">
                        {t.last_date ? dateLabel(t.last_date) : "no date"}
                      </div>
                    </div>
                    <button
                      onClick={() => void link(t)}
                      disabled={busy}
                      className="g-btn g-btn-sm g-btn-pri shrink-0"
                    >
                      Link
                    </button>
                  </div>
                ))}
              </section>
            )}
          </div>
        </div>

        {/* RIGHT: the selected thread's messages */}
        <div className="flex-1 min-w-0 flex flex-col min-h-0">
          {!selected ? (
            <div className="flex-1 flex items-center justify-center text-sm text-subtext-0">
              Select a linked thread to read it.
            </div>
          ) : (
            <>
              <div className="g-bar px-5 py-2.5 justify-between !gap-3 shrink-0">
                <div className="min-w-0">
                  <div className="text-base font-semibold text-text truncate" title={subjectOf(selected)}>
                    {subjectOf(selected)}
                  </div>
                  <div className="text-xs text-subtext-0">
                    {selected.message_count} message{selected.message_count !== 1 ? "s" : ""}
                  </div>
                </div>
                <div className="flex gap-2 shrink-0">
                  <button
                    onClick={() => void loadMessages(selected.id)}
                    className="g-btn g-btn-sm g-btn-ghost"
                  >
                    Refresh
                  </button>
                  {selected.is_mine && (
                    <button
                      onClick={() => void unlink(selected)}
                      disabled={busy}
                      className="g-btn g-btn-sm g-btn-danger"
                    >
                      Unlink
                    </button>
                  )}
                </div>
              </div>
              <div className="flex-1 overflow-y-auto p-5 space-y-3">
                {msgError && (
                  <div className="text-sm text-error bg-error/10 border border-error/30 rounded-lg px-3 py-2">
                    {msgError}
                  </div>
                )}
                {orderedMessages.length === 0 && !msgError && (
                  <p className="text-sm text-subtext-0 italic">No messages in this thread yet.</p>
                )}
                {orderedMessages.map((m) => (
                  <div key={m.id} className="g-card px-5 py-4">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-sm font-medium text-text truncate" title={m.from_addr}>
                        {m.from_addr}
                      </span>
                      <span className="text-xs text-subtext-0 shrink-0">
                        {m.date ? dateLabel(m.date) : ""}
                      </span>
                    </div>
                    {m.body_text != null ? (
                      <div className="g-read mt-2 text-sm text-text whitespace-pre-wrap break-words">
                        {m.body_text}
                      </div>
                    ) : (
                      <div className="mt-2 text-sm text-subtext-0 italic">
                        (body not fetched yet — syncs shortly after linking)
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
