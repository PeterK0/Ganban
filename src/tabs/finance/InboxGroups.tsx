// "To sort" by payee: the host groups the lines (fin_inbox_groups) by direction and merchant, so ten
// thousand lines become a few hundred rows, the largest first. One pick files a whole group and
// teaches its payee the category (the Undo toast comes from `fileGroup`). With a local model on the host, "Suggest categories for all unsorted" runs
// in the background and fills one suggestion per group; the user takes them group by group.
import { useCallback, useEffect, useRef, useState } from 'react';
import * as fin from './api';
import { bulkErrorText, dateRange, suggestJobText } from './inbox.pure';
import { formatDate } from './money.pure';
import { AccountPicker, Empty, MUTED, Money, errText, useFinance } from './shared';
import { useRailShell } from '../../components/RailViews';

const PAGE = 50;
const POLL_MS = 1500;

/** Calls `onMore` when the returned element scrolls into view (paging on scroll). */
export function useLoadMore(enabled: boolean, onMore: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  const more = useRef(onMore);
  more.current = onMore;
  useEffect(() => {
    const el = ref.current;
    if (!enabled || !el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver((seen) => seen.some((s) => s.isIntersecting) && more.current(), { rootMargin: '300px' });
    io.observe(el);
    return () => io.disconnect();
  }, [enabled]);
  return ref;
}

export default function InboxGroups({
  filter,
  canSuggest,
  onShowLines,
  fileGroup,
}: {
  /** The inbox's filters (drafts only; the host adds that). */
  filter: fin.EntryFilter;
  canSuggest: boolean;
  onShowLines: (g: fin.InboxGroup) => void;
  /** Files every uncategorised line of a filter under a category, with the toast. */
  fileGroup: (filter: fin.EntryFilter, ledgerAccountId: number) => Promise<fin.CategoriseMatching | string>;
}) {
  const { ledgerById, entity, locale } = useFinance();
  const touch = useRailShell() === 'touch';
  const [groups, setGroups] = useState<fin.InboxGroup[]>([]);
  const [totals, setTotals] = useState({ groups: 0, lines: 0 });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [job, setJob] = useState<fin.SuggestJob | null>(null);
  const seq = useRef(0);

  const shown = useRef(0);
  shown.current = groups.length;
  /** The first page, or the next one (`append`); `keep` reloads as many as are shown. */
  const load = useCallback(
    async (append = false, from = 0, keep = false) => {
      const my = ++seq.current;
      setLoading(true);
      try {
        const r = await fin.inboxGroups(filter, keep ? Math.min(500, Math.max(PAGE, shown.current)) : PAGE, append ? from : 0);
        if (my !== seq.current) return;
        setGroups((prev) => (append ? [...prev, ...r.groups] : r.groups));
        setTotals({ groups: r.total_groups, lines: r.total_lines });
      } catch (e) {
        if (my === seq.current) setMsg(errText(e));
      } finally {
        if (my === seq.current) setLoading(false);
      }
    },
    [filter],
  );

  useEffect(() => {
    void load();
  }, [load]);

  // Follow a suggestion job (one started earlier, or here) until it ends, refreshing the groups as it fills them.
  const following = job?.state === 'running';
  useEffect(() => {
    if (!canSuggest) return;
    fin.suggestGroupsStatus().then((j) => j?.state === 'running' && setJob(j)).catch(() => {});
  }, [canSuggest]);
  useEffect(() => {
    if (!following) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let seen = -1;
    const tick = async () => {
      try {
        const j = await fin.suggestGroupsStatus();
        if (stop) return;
        setJob(j);
        if (j?.state === 'running') timer = setTimeout(tick, POLL_MS);
        // New suggestions arrived (or the job ended): show them without losing the scroll.
        if (!j || j.done !== seen || j.state !== 'running') void load(false, 0, true);
        seen = j?.done ?? -1;
      } catch {
        if (!stop) timer = setTimeout(tick, POLL_MS * 2);
      }
    };
    timer = setTimeout(tick, POLL_MS);
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [following, load]);

  const suggestAll = async () => {
    setMsg(null);
    try {
      setJob(await fin.suggestGroups());
    } catch (e) {
      setMsg(errText(e));
    }
  };

  const sortGroup = async (g: fin.InboxGroup, ledgerAccountId: number) => {
    setBusy(g.key);
    setMsg(null);
    const r = await fileGroup({ ...filter, groupKey: g.key }, ledgerAccountId);
    if (typeof r === 'string') {
      setMsg(bulkErrorText(r));
      window.setTimeout(() => void load(false, 0, true), 8000);
    } else {
      // A filed group leaves the list.
      setGroups((gs) => gs.filter((x) => x.key !== g.key || r.categorised < x.uncategorised));
      void load(false, 0, true);
    }
    setBusy(null);
  };

  const dismiss = async (g: fin.InboxGroup) => {
    try {
      await fin.dismissGroupSuggestion(g.key);
      setGroups((gs) => gs.map((x) => (x.key === g.key ? { ...x, suggested_ledger_account_id: null } : x)));
    } catch (e) {
      setMsg(errText(e));
    }
  };

  const more = !loading && groups.length < totals.groups;
  const sentinel = useLoadMore(more, () => void load(true, groups.length));
  const unsortedGroups = groups.some((g) => g.uncategorised > 0);

  return (
    <div className="space-y-3">
      <div className="g-inset flex flex-wrap items-center gap-3 px-3 py-2">
        <span className="text-sm text-subtext-1">
          {totals.lines.toLocaleString(locale)} {totals.lines === 1 ? 'line' : 'lines'} from {totals.groups.toLocaleString(locale)} {totals.groups === 1 ? 'payee' : 'payees'}, the most lines first
        </span>
        {canSuggest && (unsortedGroups || following) && (
          <button
            className={`g-btn g-btn-ghost g-btn-sm ml-auto ${touch ? 'min-h-[44px]' : ''}`}
            disabled={following}
            title="Ask the host's local model for a category for every unsorted payee. It runs in the background; nothing is applied until you take it."
            onClick={() => void suggestAll()}
          >
            {following ? 'Suggesting…' : 'Suggest categories for all unsorted'}
          </button>
        )}
      </div>
      {job && (
        <p className="text-sm text-subtext-1" role="status">
          {suggestJobText(job, locale)}
        </p>
      )}
      {msg && <p className="text-sm text-subtext-1">{msg}</p>}

      {!loading && groups.length === 0 ? (
        <Empty title="Nothing to sort">Lines your payees and rules can’t file wait here after an import.</Empty>
      ) : (
        <div className="g-plain" role="list">
          {groups.map((g) => {
            const transfers = g.paired === g.count;
            const suggested = g.suggested_ledger_account_id != null ? ledgerById.get(g.suggested_ledger_account_id) : undefined;
            const sorted = g.uncategorised === 0 && !transfers;
            return (
              <div key={g.key} role="listitem" className="border-b border-gilt-b">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 min-h-[52px] px-3 py-1.5">
                  <button className={`flex-1 min-w-[160px] text-left ${touch ? 'min-h-[44px]' : ''}`} onClick={() => onShowLines(g)} title="Show these lines">
                    <span className="block text-text truncate">{g.label || '(no description)'}</span>
                    <span className={`block text-xs ${MUTED} truncate`}>
                      {g.count.toLocaleString(locale)} {g.count === 1 ? 'line' : 'lines'} · {dateRange(g.first_date, g.last_date, (d) => formatDate(d, locale))}
                      {g.direction === 'in' ? ' · money in' : ''}
                    </span>
                  </button>
                  <span className="flex items-center gap-2 order-last sm:order-none w-full sm:w-[260px] pl-0">
                    {transfers ? (
                      <button className={`g-btn g-btn-ghost g-btn-sm ${touch ? 'min-h-[44px]' : ''}`} onClick={() => onShowLines(g)} title="Lines that may be money moved between your accounts">
                        Transfer? Check the lines
                      </button>
                    ) : sorted ? (
                      <span className={`text-sm truncate ${MUTED}`}>{g.category_id != null ? ledgerById.get(g.category_id)?.name : 'Filed'}</span>
                    ) : (
                      <>
                        <AccountPicker
                          label={`Category for ${g.label}`}
                          value={null}
                          placeholder={busy === g.key ? 'Filing…' : suggested ? suggested.name : g.uncategorised < g.count ? `${g.uncategorised.toLocaleString(locale)} to sort · category…` : 'Pick a category…'}
                          onChange={(id) => void sortGroup(g, id)}
                          className={`flex-1 min-w-0 ${suggested ? 'italic' : ''}`}
                        />
                        {suggested && (
                          <>
                            <button className={`g-btn g-btn-gilt g-btn-sm flex-none ${touch ? 'min-h-[44px]' : ''}`} disabled={busy === g.key} onClick={() => void sortGroup(g, suggested.id)} title={`File ${g.uncategorised} under ${suggested.name}`} aria-label={`Accept ${suggested.name}`}>
                              ✓
                            </button>
                            <button className="g-iconbtn flex-none" onClick={() => void dismiss(g)} title={`Not ${suggested.name}`} aria-label={`Not ${suggested.name}`}>
                              ×
                            </button>
                          </>
                        )}
                      </>
                    )}
                  </span>
                  <Money minor={g.total_minor} currency={entity.functional_currency} colour className="w-[110px] text-right ml-auto sm:ml-0" />
                </div>
              </div>
            );
          })}
        </div>
      )}
      <div ref={sentinel} className={`flex items-center gap-3 text-sm ${MUTED}`}>
        {loading ? 'Loading…' : `${groups.length} of ${totals.groups.toLocaleString(locale)} payees`}
        {more && (
          <button className="g-btn g-btn-ghost g-btn-sm" onClick={() => void load(true, groups.length)}>
            Show more
          </button>
        )}
      </div>
    </div>
  );
}
