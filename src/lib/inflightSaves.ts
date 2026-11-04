// Saves on their way to the host. A page going away cuts off its ordinary
// requests, so a save still in flight then would be lost even though the editor
// counts it as sent. The editor's unload flush sends each one again; by then
// requests go out as keepalive (daemon.ts, setUnloading), which the browser
// finishes after the page is gone. Only for idempotent saves (an update with
// the same input), since the first copy may land too.

export interface InflightSaves<M = unknown> {
  /** Run `send` and keep it for a resend until it settles. `meta` describes it
   * for resend's filter (what the save writes, say). */
  track<T>(send: () => Promise<T>, meta?: M): Promise<T>;
  /** Send every unsettled save again (those `keep` accepts); resolves when the
   * resends have settled. A newer save of the same fields going out at the
   * same time should leave the older one out: the two may land in any order. */
  resend(keep?: (meta: M | undefined) => boolean): Promise<void>;
  /** How many saves are in flight. */
  readonly size: number;
}

export function inflightSaves<M = unknown>(): InflightSaves<M> {
  const live = new Set<{ send: () => Promise<unknown>; meta?: M }>();
  return {
    track<T>(send: () => Promise<T>, meta?: M): Promise<T> {
      const entry = { send, meta };
      live.add(entry);
      let p: Promise<T>;
      try {
        p = send();
      } catch (e) {
        live.delete(entry);
        return Promise.reject(e);
      }
      return p.finally(() => live.delete(entry));
    },
    async resend(keep?: (meta: M | undefined) => boolean): Promise<void> {
      const again = [...live].filter((e) => !keep || keep(e.meta));
      await Promise.allSettled(
        again.map((e) => {
          try {
            return e.send();
          } catch (err) {
            return Promise.reject(err);
          }
        }),
      );
    },
    get size() {
      return live.size;
    },
  };
}
