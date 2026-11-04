// The pieces the Finance reports draw with: a statement table (rows with subtotals, comparatives and
// a change column), the forecast band and a budget bar. They take plain numbers; the screens fetch.
import { useLayoutEffect, useRef, useState, type ReactElement } from 'react';
import ScrollArea from '../../components/ScrollArea';
import { formatAmount, formatMoney, formatMoneyShort } from './money.pure';
import { bandGeometry, budgetProgress, formatPct, type Band, type StatementRow } from './reports.pure';
import { MUTED, useFinance } from './shared';

// ── Statement table ──────────────────────────────────────────────────────

const COL = 'w-[104px] sm:w-[128px] shrink-0 text-right tabular-nums';
const CHG = 'w-[64px] shrink-0 text-right tabular-nums';
/** Below this width the comparative stacks under the amount, so a phone reads a statement without swiping. */
const STACK_BELOW = 520;

/** Whether the element is narrower than `px` (tracks resizes). */
function useNarrow(px: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [narrow, setNarrow] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const check = () => setNarrow(el.clientWidth > 0 && el.clientWidth < px);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [px]);
  return [ref, narrow] as const;
}

/**
 * A statement as a table: the label column, one column per period (the current one first) and,
 * with comparatives, the change against the previous period. Groups fold on their heading.
 */
export function StatementTable({
  columns,
  rows,
  currency,
  onToggle,
  caption,
}: {
  columns: string[];
  rows: StatementRow[];
  currency: string;
  /** Fold or unfold a group (by its node key); without it, groups don't fold. */
  onToggle?: (node: string) => void;
  caption?: string;
}): ReactElement {
  const { locale } = useFinance();
  const comp = columns.length >= 2;
  const num = (v: number) => (v === 0 ? '–' : formatAmount(v, currency, locale));
  const minW = 220 + columns.length * 128 + (comp ? 64 : 0);
  const [box, narrow] = useNarrow(STACK_BELOW);
  if (narrow) return <div ref={box}><StackedStatement columns={columns} rows={rows} num={num} onToggle={onToggle} caption={caption} /></div>;
  return (
    <div ref={box}>
    <ScrollArea direction="horizontal" autoHide thumbSize={4}>
      <div role="table" aria-label={caption} className="g-plain text-sm" style={{ minWidth: minW }}>
        <div role="row" className="flex items-center gap-3 px-1 min-h-[36px] border-b border-gilt-b">
          <span role="columnheader" className="g-cap flex-1 min-w-[200px]" />
          {columns.map((c, i) => (
            <span key={c} role="columnheader" className={`g-cap ${COL} ${i > 0 ? MUTED : ''}`}>
              {c}
            </span>
          ))}
          {comp && (
            <span role="columnheader" className={`g-cap ${CHG}`}>
              Change
            </span>
          )}
        </div>
        {rows.map((r) => {
          const strong = r.kind === 'subtotal' || r.kind === 'total';
          const foldable = onToggle && (r.kind === 'heading' || r.collapsed);
          const label = (
            <span className="truncate">
              {foldable && <span aria-hidden className={`inline-block w-3 ${MUTED}`}>{r.collapsed ? '▸' : '▾'}</span>}
              {r.label}
            </span>
          );
          return (
            <div
              key={r.key}
              role="row"
              className={`flex items-center gap-3 px-1 ${
                r.kind === 'total' ? 'min-h-[40px] border-t-2 border-gilt-b font-semibold text-text' : r.kind === 'subtotal' ? 'min-h-[34px] border-t border-gilt-b font-semibold text-text' : r.kind === 'heading' ? 'min-h-[34px] pt-2 text-text' : 'min-h-[30px] text-subtext-1'
              }`}
            >
              <span role="rowheader" className="flex-1 min-w-[200px] flex" style={{ paddingLeft: r.depth * 16 }}>
                {foldable ? (
                  <button className={`text-left min-w-0 truncate hover:text-gold ${r.kind === 'heading' ? 'g-stitle !text-[13px]' : ''}`} aria-expanded={!r.collapsed} onClick={() => onToggle(r.node)}>
                    {label}
                  </button>
                ) : (
                  <span className={`min-w-0 truncate ${r.kind === 'heading' ? 'g-stitle !text-[13px]' : ''}`}>{label}</span>
                )}
              </span>
              {r.kind === 'heading'
                ? columns.map((c) => <span key={c} role="cell" className={COL} />)
                : r.values.map((v, i) => (
                    <span key={i} role="cell" className={`${COL} ${i > 0 ? MUTED : ''} ${!strong && v === 0 ? MUTED : ''}`}>
                      {num(v)}
                    </span>
                  ))}
              {comp && (
                <span role="cell" className={`${CHG} text-xs ${MUTED}`}>
                  {r.kind === 'heading' ? '' : formatPct(r.changePct, locale)}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </ScrollArea>
    </div>
  );
}

/**
 * The statement on a narrow screen: the label and the current amount on a line, and the previous
 * period with the change in small type under the amount, so nothing sits off-screen.
 */
function StackedStatement({
  columns,
  rows,
  num,
  onToggle,
  caption,
}: {
  columns: string[];
  rows: StatementRow[];
  num: (v: number) => string;
  onToggle?: (node: string) => void;
  caption?: string;
}): ReactElement {
  const { locale } = useFinance();
  const comp = columns.length >= 2;
  return (
    <div role="table" aria-label={caption} className="g-plain text-sm">
      <div role="row" className="flex items-end gap-2 px-1 py-1.5 border-b border-gilt-b">
        <span role="columnheader" className="g-cap flex-1 min-w-0" />
        <span role="columnheader" className="g-cap shrink-0 text-right">
          {columns[0]}
          {comp && <span className={`block normal-case tracking-normal font-normal text-[11px] ${MUTED}`}>vs {columns[1]}</span>}
        </span>
      </div>
      {rows.map((r) => {
        const strong = r.kind === 'subtotal' || r.kind === 'total';
        const foldable = onToggle && (r.kind === 'heading' || r.collapsed);
        const label = (
          <>
            {foldable && <span aria-hidden className={`inline-block w-3 ${MUTED}`}>{r.collapsed ? '▸' : '▾'}</span>}
            {r.label}
          </>
        );
        const head = r.kind === 'heading' ? 'g-stitle !text-[13px]' : '';
        return (
          <div
            key={r.key}
            role="row"
            className={`flex items-center gap-2 px-1 py-1 ${
              r.kind === 'total' ? 'min-h-[44px] border-t-2 border-gilt-b font-semibold text-text' : r.kind === 'subtotal' ? 'min-h-[40px] border-t border-gilt-b font-semibold text-text' : r.kind === 'heading' ? 'min-h-[40px] pt-2 text-text' : 'min-h-[36px] text-subtext-1'
            }`}
          >
            <span role="rowheader" className="flex-1 min-w-0 flex" style={{ paddingLeft: r.depth * 12 }}>
              {foldable ? (
                <button className={`text-left min-w-0 min-h-[44px] break-words hover:text-gold ${head}`} aria-expanded={!r.collapsed} onClick={() => onToggle(r.node)}>
                  {label}
                </button>
              ) : (
                <span className={`min-w-0 break-words ${head}`}>{label}</span>
              )}
            </span>
            {r.kind !== 'heading' && (
              <span role="cell" className="shrink-0 text-right tabular-nums">
                <span className={!strong && r.values[0] === 0 ? MUTED : ''}>{num(r.values[0] ?? 0)}</span>
                {comp && (
                  <span className={`block text-[11px] font-normal ${MUTED}`}>
                    {num(r.values[1] ?? 0)}
                    {r.changePct != null ? ` · ${formatPct(r.changePct, locale)}` : ''}
                  </span>
                )}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── The forecast band ────────────────────────────────────────────────────

/**
 * The end-of-month balance as a band on one line: the low–high range as a bar, the expected value
 * as a mark in it, today's balance as a hollow mark, and zero as a rule when it's in view.
 */
export function ForecastBand({ band, currency, compact = false }: { band: Band; currency: string; compact?: boolean }): ReactElement {
  const { locale } = useFinance();
  const g = bandGeometry(band);
  const short = (v: number) => formatMoneyShort(v, currency, locale);
  const lo = g.pos(band.low);
  const hi = g.pos(band.high);
  const risk = band.low < 0;
  return (
    <div className="space-y-2">
      <div
        className="relative h-6"
        role="img"
        aria-label={`Expected ${formatMoney(band.expected, currency, locale)}, between ${formatMoney(band.low, currency, locale)} and ${formatMoney(band.high, currency, locale)}; now ${formatMoney(band.current, currency, locale)}.`}
      >
        <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 h-1 rounded bg-surface-0" />
        {g.zero != null && <div className="absolute top-0 bottom-0 w-px bg-error/70" style={{ left: `${g.zero}%` }} title="Zero" />}
        <div className={`absolute top-1/2 -translate-y-1/2 h-3 rounded ${risk ? 'bg-warning/45' : 'bg-gold/35'}`} style={{ left: `${lo}%`, width: `${Math.max(hi - lo, 0.8)}%` }} />
        <div className={`absolute top-0 bottom-0 w-[3px] -ml-[1.5px] rounded ${risk ? 'bg-warning' : 'bg-gold'}`} style={{ left: `${g.pos(band.expected)}%` }} title="Expected" />
        <div className="absolute top-1/2 w-3 h-3 -ml-1.5 -mt-1.5 rounded-full border-2 border-text bg-mantle" style={{ left: `${g.pos(band.current)}%` }} title="Now" />
      </div>
      {!compact && (
        <div className={`relative h-4 text-[11px] ${MUTED} tabular-nums`} aria-hidden>
          {g.ticks.map((t, i) => (
            <span key={t} className="absolute -translate-x-1/2 whitespace-nowrap" style={{ left: `${g.pos(t)}%`, ...(i === 0 ? { transform: 'none' } : i === g.ticks.length - 1 ? { transform: 'translateX(-100%)' } : {}) }}>
              {short(t)}
            </span>
          ))}
        </div>
      )}
      <div className={`flex flex-wrap gap-x-4 gap-y-1 text-xs ${MUTED}`}>
        <span>
          <span className="inline-block w-3 h-3 rounded-full border-2 border-text align-[-2px] mr-1" /> Now {formatMoney(band.current, currency, locale)}
        </span>
        <span>
          <span className={`inline-block w-[3px] h-3 align-[-2px] mr-1 ${risk ? 'bg-warning' : 'bg-gold'}`} /> Expected {formatMoney(band.expected, currency, locale)}
        </span>
        <span>
          <span className={`inline-block w-4 h-2 rounded align-[0px] mr-1 ${risk ? 'bg-warning/45' : 'bg-gold/35'}`} /> Range {formatMoney(band.low, currency, locale)} – {formatMoney(band.high, currency, locale)}
        </span>
      </div>
    </div>
  );
}

// ── Budget bar ───────────────────────────────────────────────────────────

const STATE_TONE = { none: 'bg-subtext-0', under: 'bg-success', pace: 'bg-gold', warn: 'bg-warning', over: 'bg-error' } as const;
const STATE_LABEL = { none: '', under: '', pace: 'Near the target', warn: 'Heading over', over: 'Over' } as const;

/**
 * One budget's progress: spent against the target, a mark for how far into the month it is, and a
 * dashed end where the forecast says the month will land.
 */
export function BudgetBar({
  name,
  spent,
  target,
  elapsed,
  projected,
  currency,
  onClick,
}: {
  name: string;
  spent: number;
  target: number;
  elapsed: number;
  projected?: number | null;
  currency: string;
  onClick?: () => void;
}): ReactElement {
  const { locale } = useFinance();
  const p = budgetProgress(spent, target, elapsed, projected);
  // The bar's scale reaches past the target when spending or the forecast does.
  const scale = Math.max(1, p.spentPct, p.projectedPct ?? 0);
  const at = (f: number) => `${Math.min(100, (f / scale) * 100)}%`;
  const body = (
    <>
      <div className="flex items-baseline gap-2 text-sm">
        <span className="flex-1 min-w-0 truncate text-text">{name}</span>
        <span className="tabular-nums whitespace-nowrap">
          <span className="text-text">{formatMoney(spent, currency, locale)}</span>
          <span className={MUTED}> / {formatMoney(target, currency, locale)}</span>
        </span>
      </div>
      <div className="relative h-2 mt-1.5 rounded bg-surface-0" role="progressbar" aria-label={`${name}: spent`} aria-valuemin={0} aria-valuemax={target} aria-valuenow={spent}>
        <div className={`absolute inset-y-0 left-0 rounded ${STATE_TONE[p.state]}`} style={{ width: at(p.spentPct) }} />
        {p.projectedPct != null && p.projectedPct > p.spentPct && (
          <div className={`absolute inset-y-0 rounded-r border border-dashed ${p.state === 'warn' || p.state === 'over' ? 'border-warning' : 'border-subtext-0'}`} style={{ left: at(p.spentPct), width: `calc(${at(p.projectedPct)} - ${at(p.spentPct)})` }} title="Forecast" />
        )}
        {scale > 1 && <div className="absolute -top-0.5 -bottom-0.5 w-px bg-text" style={{ left: at(1) }} title="Target" />}
        {elapsed > 0 && elapsed < 1 && <div className={`absolute -top-1 -bottom-1 w-px bg-subtext-0`} style={{ left: at(elapsed) }} title="Today" />}
      </div>
      <div className={`mt-1 flex items-center gap-2 text-xs ${MUTED} tabular-nums`}>
        <span className="flex-1 min-w-0">
        {p.state === 'none'
          ? 'No target'
          : p.left >= 0
            ? `${formatMoney(p.left, currency, locale)} left`
            : `${formatMoney(-p.left, currency, locale)} over`}
        {projected != null && p.state !== 'none' && ` · forecast ${formatMoney(projected, currency, locale)}`}
        </span>
        {STATE_LABEL[p.state] && <span className={`g-tag ${p.state === 'over' ? 'g-tag-red' : p.state === 'warn' ? 'g-tag-warn' : ''} !min-h-[18px] !px-1.5 text-[11px] shrink-0`}>{STATE_LABEL[p.state]}</span>}
      </div>
    </>
  );
  return onClick ? (
    <button className="block w-full text-left rounded px-2 py-1.5 -mx-2 hover:bg-surface-0 transition-colors" onClick={onClick}>
      {body}
    </button>
  ) : (
    <div className="py-1.5">{body}</div>
  );
}
