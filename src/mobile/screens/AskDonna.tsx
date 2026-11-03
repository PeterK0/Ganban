// "Ask Donna" on the phone's home screen — the same grounded secretary chat
// as the desktop Home widget, with tools (find task, create linked event), so
// adding something takes one sentence on the go. The endpoint is owner-only;
// a member's first send gets a friendly refusal and the strip hides itself.

import { useEffect, useRef, useState } from "react";
import { streamSecretary } from "../../lib/daemon";
import { loadSecretaryThread, saveSecretaryThread, clearSecretaryThread } from "../../lib/secretaryThread";

interface Msg {
  role: "user" | "assistant";
  content: string;
}

export default function AskDonna() {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  // Shared persisted thread (same key as the desktop widget — one Donna).
  const [msgs, setMsgs] = useState<Msg[]>(() => loadSecretaryThread());
  const [busy, setBusy] = useState(false);
  const [hidden, setHidden] = useState(false);
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    listRef.current?.scrollTo(0, listRef.current.scrollHeight);
    saveSecretaryThread(msgs);
  }, [msgs]);

  const send = async () => {
    const message = input.trim();
    if (!message || busy) return;
    setInput("");
    setBusy(true);
    const history = msgs.map((m) => ({ role: m.role, content: m.content }));
    setMsgs((ms) => [...ms, { role: "user", content: message }, { role: "assistant", content: "" }]);
    const append = (tok: string) =>
      setMsgs((ms) => {
        const out = [...ms];
        const last = out[out.length - 1];
        if (last?.role === "assistant") out[out.length - 1] = { ...last, content: last.content + tok };
        return out;
      });
    try {
      await streamSecretary(
        { message, history },
        {
          onToken: append,
          onError: (e) => append(`\n(${e})`),
        }
      );
    } catch (e) {
      const status = (e as { status?: number }).status;
      if (status === 401 || status === 403) setHidden(true);
      else append(`\n(${e instanceof Error ? e.message : String(e)})`);
    } finally {
      setBusy(false);
    }
  };

  if (hidden) return null;

  return (
    <div className="mb-3">
      {!open ? (
        <button
          onClick={() => setOpen(true)}
          className="g-card w-full flex items-center gap-3 px-4 min-h-[48px] text-left active:bg-surface-0"
        >
          <span className="g-gem" aria-hidden="true" />
          <span className="text-sm gm-mut">Ask Donna — add an event, find a task…</span>
        </button>
      ) : (
        <div className="g-card overflow-hidden">
          <div className="flex items-center justify-between pl-4 pr-1 border-b border-gilt-b">
            <span className="g-deco flex items-center gap-2 text-[12px] font-semibold text-gold pt-0.5"><span className="g-gem w-1.5 h-1.5" aria-hidden="true" />Donna</span>
            <span className="flex items-center gap-1">
              {msgs.length > 0 && (
                <button onClick={() => { setMsgs([]); clearSecretaryThread(); }} className="text-xs gm-mut px-3 min-h-[44px]">
                  clear
                </button>
              )}
              <button onClick={() => setOpen(false)} className="text-xs gm-mut px-3 min-h-[44px]">
                close
              </button>
            </span>
          </div>
          {msgs.length > 0 && (
            <div ref={listRef} className="max-h-64 overflow-y-auto px-4 py-2 space-y-2">
              {msgs.map((m, i) => (
                <div key={i} className={`text-sm whitespace-pre-wrap break-words ${m.role === "user" ? "text-primary" : "text-text"}`}>
                  {m.role === "user" ? "› " : ""}
                  {m.content || (busy && i === msgs.length - 1 ? "…" : "")}
                </div>
              ))}
            </div>
          )}
          <div className="flex gap-2 p-2 border-t border-gilt-b">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void send();
              }}
              placeholder='e.g. "event Friday 2pm for the visa task"'
              className="g-field gm-field"
            />
            <button
              onClick={() => void send()}
              disabled={busy || !input.trim()}
              className="g-btn g-btn-pri shrink-0 min-h-[44px] px-4"
            >
              {busy ? "…" : "Send"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
