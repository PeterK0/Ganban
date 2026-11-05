// Import: a bank export in, drafts out. Pick the file, check the preview (the bank's profile, or map
// the columns once with the wizard), say which account each part of the file belongs to, import, and
// confirm the transfers the matcher wasn't sure about.
import { useEffect, useRef, useState } from 'react';
import { DecoHeading } from '../../components/gilt';
import { confirmDialog } from '../../lib/confirm';
import * as fin from './api';
import { progressPercent, stageLabel } from './importJob.pure';
import { AUTO_PERCENT, clampPercent, pairsAtLeast, pairsLike } from './reviewPairs.pure';
import { formatDate } from './money.pure';
import { Empty, MUTED, Money, errText, splitEntry, useFinance } from './shared';

type Step =
  | { at: 'pick' }
  | { at: 'preview'; file: File; b64: string; preview: fin.ImportPreview }
  | { at: 'running'; job: fin.ImportJob }
  | { at: 'done'; result: fin.ImportResult };

/** How often the screen asks the host how the import is going. */
const POLL_MS = 700;
/** Failed status checks in a row before the screen stops following an import. */
const MAX_MISSES = 8;

export default function ImportView() {
  const { reload } = useFinance();
  const [step, setStep] = useState<Step>({ at: 'pick' });
  const [profiles, setProfiles] = useState<fin.Profile[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fin.listProfiles().then(setProfiles).catch(() => setProfiles([]));
    // An import started before a refresh (or on another screen) is still running: follow it.
    fin
      .importStatus()
      .then((job) => {
        if (job?.state === 'running') setStep((s) => (s.at === 'pick' ? { at: 'running', job } : s));
      })
      .catch(() => {});
  }, []);

  // Follow a running import until it's done.
  const runningId = step.at === 'running' ? step.job.job_id : null;
  useEffect(() => {
    if (runningId == null) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let misses = 0;
    const gone = (why: string) => {
      setStep({ at: 'pick' });
      setMsg(`${why} Run the same file again: it adds only what is missing.`);
      void reload();
    };
    const tick = async () => {
      try {
        const job = await fin.importStatus(runningId);
        if (stop) return;
        misses = 0;
        if (!job) gone('The import is no longer on the host.');
        else if (job.state === 'running') {
          setStep({ at: 'running', job });
          timer = setTimeout(tick, POLL_MS);
        } else if (job.state === 'done' && job.result) {
          setStep({ at: 'done', result: job.result });
          void reload();
        } else gone(job.error ? `${job.error}.` : 'The import stopped.');
      } catch (e) {
        if (stop) return;
        // A passing failure (the network, a busy host) keeps following the job; only a
        // job the host no longer knows (it restarted), or a run of failures, gives up.
        const text = errText(e);
        if (/not found/i.test(text) || ++misses >= MAX_MISSES) gone(`${text}.`);
        else timer = setTimeout(tick, POLL_MS * 2);
      }
    };
    timer = setTimeout(tick, POLL_MS);
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [runningId, reload]);

  const preview = async (file: File, b64?: string, profileKey?: string) => {
    if (file.size > fin.MAX_IMPORT_BYTES) {
      setMsg('That file is over 1.5 MB, the most one import takes. Export a shorter period.');
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const content = b64 ?? (await fin.fileToBase64(file));
      const p = await fin.previewImport(file.name, content, profileKey);
      setStep({ at: 'preview', file, b64: content, preview: p });
    } catch (e) {
      setMsg(errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <ReviewList />

      <section className="space-y-4">
        <DecoHeading>Import a statement</DecoHeading>
        {step.at === 'pick' && (
          <div className="g-card g-corners p-6 space-y-3 text-center">
            <p className="text-text">A CSV or Excel export from your bank.</p>
            <p className={`text-sm ${MUTED}`}>Revolut and Piraeus are recognised; for another bank you map its columns once. Re-importing an overlapping export adds nothing twice.</p>
            <input
              ref={input}
              type="file"
              accept=".csv,.xlsx,.xls,.txt,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (f) void preview(f);
              }}
            />
            <button className="g-btn g-btn-pri" disabled={busy} onClick={() => input.current?.click()}>
              {busy ? 'Reading…' : 'Choose a file'}
            </button>
          </div>
        )}
        {step.at === 'preview' && (
          <Preview
            key={step.preview.profile_key ?? 'none'}
            file={step.file}
            preview={step.preview}
            profiles={profiles}
            busy={busy}
            onProfile={(key) => void preview(step.file, step.b64, key)}
            onProfileSaved={(p) => {
              setProfiles((ps) => [...ps.filter((x) => x.key !== p.key), p]);
              void preview(step.file, step.b64, p.key);
            }}
            onCancel={() => setStep({ at: 'pick' })}
            onImport={async (profileKey, map, postOlderThanDays) => {
              setBusy(true);
              setMsg(null);
              try {
                const job = await fin.runImport(step.file.name, step.b64, profileKey, map, postOlderThanDays);
                setStep({ at: 'running', job });
              } catch (e) {
                setMsg(errText(e));
              } finally {
                setBusy(false);
              }
            }}
          />
        )}
        {step.at === 'running' && <Running job={step.job} />}
        {step.at === 'done' && <Result result={step.result} onAgain={() => setStep({ at: 'pick' })} />}
        {msg && <p className="text-sm text-error">{msg}</p>}
      </section>
    </div>
  );
}

function Preview({
  file,
  preview,
  profiles,
  busy,
  onProfile,
  onProfileSaved,
  onCancel,
  onImport,
}: {
  file: File;
  preview: fin.ImportPreview;
  profiles: fin.Profile[];
  busy: boolean;
  onProfile: (key: string) => void;
  onProfileSaved: (p: fin.Profile) => void;
  onCancel: () => void;
  onImport: (profileKey: string, map: Record<string, fin.AccountMapTarget>, postOlderThanDays?: number) => Promise<void>;
}) {
  const { accounts, locale } = useFinance();
  const [wizard, setWizard] = useState(!preview.profile_key);
  const [map, setMap] = useState<Record<string, number | 'create'>>(() =>
    Object.fromEntries(preview.accounts.map((a) => [a.guess_key, a.matched_account_id ?? 'create'])),
  );
  const live = accounts.filter((a) => !a.archived);
  const profileKey = preview.profile_key;
  // "Post lines older than N days straight away": off by default, remembered per user on the host.
  const [postOlder, setPostOlder] = useState<{ on: boolean; days: string }>({ on: false, days: '30' });
  useEffect(() => {
    fin
      .getSettings()
      .then((s) => setPostOlder({ on: s.import.post_older, days: String(s.import.post_older_days) }))
      .catch(() => {});
  }, []);
  const postDays = Math.round(Number(postOlder.days));
  const daysOk = Number.isFinite(postDays) && postDays >= 1 && postDays <= 3650;
  const savePostOlder = (next: { on: boolean; days: string }) => {
    setPostOlder(next);
    const d = Math.round(Number(next.days));
    if (Number.isFinite(d) && d >= 1 && d <= 3650) void fin.updateImportSettings({ postOlder: next.on, postOlderDays: d }).catch(() => {});
  };

  const go = () => {
    if (!profileKey) return;
    const out: Record<string, fin.AccountMapTarget> = {};
    for (const g of preview.accounts) {
      const v = map[g.guess_key];
      out[g.guess_key] =
        v === 'create' || v == null
          ? { create: { kind: g.kind, name: g.name, currency: g.currency, institution: g.institution ?? profiles.find((p) => p.key === profileKey)?.name } }
          : v;
    }
    void onImport(profileKey, out, postOlder.on && daysOk ? postDays : undefined);
  };

  return (
    <div className="space-y-4">
      <div className="g-card p-5 space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex-1 min-w-[200px]">
            <div className="text-text font-medium truncate">{file.name}</div>
            <div className={`text-xs ${MUTED}`}>
              {preview.format.toUpperCase()} · {preview.rows.length} rows shown
              {profileKey ? ` · recognised ${Math.round(preview.confidence * 100)}%` : ' · not recognised'}
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <span className="g-cap">Bank</span>
            <select className="g-field g-field-sm !w-auto" value={profileKey ?? ''} onChange={(e) => e.target.value && onProfile(e.target.value)} disabled={busy}>
              {!profileKey && <option value="">Choose…</option>}
              {profiles.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <button className="g-btn g-btn-ghost g-btn-sm" onClick={() => setWizard((w) => !w)}>
            {wizard ? 'Hide columns' : 'Map columns…'}
          </button>
        </div>
        {preview.warnings.map((w, i) => (
          <p key={i} className="text-sm g-tag g-tag-warn !rounded !py-1 !h-auto">
            {w}
          </p>
        ))}
      </div>

      {wizard && <MappingWizard sample={preview.sample ?? []} header={preview.header} onSaved={onProfileSaved} />}

      {preview.rows.length > 0 && (
        <div className="g-card p-0">
          <div className="g-stitle px-5 pt-4">Preview</div>
          <div className="px-4 pb-2">
            {preview.rows.slice(0, 8).map((r, i) => (
              <div key={i} className="g-frow text-sm">
                <span className={`w-[96px] shrink-0 ${MUTED}`}>{formatDate(r.booked_date, locale)}</span>
                <span className="flex-1 min-w-0 truncate text-text">{r.payee || r.description}</span>
                <Money minor={r.amount_minor} currency={r.currency} colour />
              </div>
            ))}
          </div>
        </div>
      )}

      {profileKey && preview.accounts.length > 0 && (
        <div className="g-card p-5 space-y-3">
          <div className="g-stitle">Accounts in this file</div>
          {preview.accounts.map((g) => {
            const same = live.filter((a) => a.currency === g.currency);
            return (
              <div key={g.guess_key} className="flex flex-wrap items-center gap-3">
                <span className="flex-1 min-w-[180px]">
                  <span className="block text-text">{g.name}</span>
                  <span className={`block text-xs ${MUTED}`}>
                    {g.kind} · {g.currency}
                  </span>
                </span>
                <select
                  className="g-field g-field-sm !w-auto min-w-[200px]"
                  value={String(map[g.guess_key] ?? 'create')}
                  onChange={(e) => setMap((m) => ({ ...m, [g.guess_key]: e.target.value === 'create' ? 'create' : Number(e.target.value) }))}
                  aria-label={`Account for ${g.name}`}
                >
                  <option value="create">Create “{g.name}”</option>
                  {same.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
              </div>
            );
          })}
        </div>
      )}

      <div className="space-y-1">
        <label className="flex flex-wrap items-center gap-2 text-sm text-text min-h-[32px]">
          <input type="checkbox" checked={postOlder.on} onChange={(e) => savePostOlder({ ...postOlder, on: e.target.checked })} />
          Post lines older than
          <input
            className="g-field g-field-sm !w-[72px] text-right tabular-nums"
            inputMode="numeric"
            value={postOlder.days}
            onChange={(e) => savePostOlder({ ...postOlder, days: e.target.value })}
            aria-label="Days"
            aria-invalid={!daysOk}
          />
          days straight away
        </label>
        <p className={`text-xs ${MUTED} pl-6`}>
          For history your bank settled long ago: those lines are paired and run through your rules, then posted instead of waiting in the inbox. Posted lines stay editable until their month is closed.
        </p>
      </div>

      <div className="flex justify-end gap-2">
        <button className="g-btn g-btn-ghost" onClick={onCancel}>
          Cancel
        </button>
        <button className="g-btn g-btn-pri" disabled={!profileKey || busy || (postOlder.on && !daysOk)} onClick={go}>
          {busy ? 'Importing…' : 'Import'}
        </button>
      </div>
    </div>
  );
}

type ColField = 'bookedDate' | 'description' | 'amount' | 'debit' | 'credit' | 'fee' | 'currency' | 'payee' | 'balance' | 'valueDate' | 'bankCategory';
const FIELDS: { key: ColField; label: string; required?: boolean }[] = [
  { key: 'bookedDate', label: 'Date', required: true },
  { key: 'description', label: 'Description', required: true },
  { key: 'amount', label: 'Amount (signed)' },
  { key: 'debit', label: 'Money out' },
  { key: 'credit', label: 'Money in' },
  { key: 'fee', label: 'Fee' },
  { key: 'currency', label: 'Currency' },
  { key: 'payee', label: 'Payee' },
  { key: 'balance', label: 'Balance' },
  { key: 'valueDate', label: 'Value date' },
  { key: 'bankCategory', label: 'Bank category' },
];

/**
 * Map an unknown bank's columns once; it's saved as a profile and used from then on. The header row
 * is picked from the file's first rows (some banks put a preamble above it), and columns are saved by
 * their header name.
 */
function MappingWizard({ sample, header, onSaved }: { sample: string[][]; header: string[]; onSaved: (p: fin.Profile) => void }) {
  const guessRow = Math.max(0, sample.findIndex((r) => r.length > 0 && r.join('\u0001') === header.join('\u0001')));
  const [headerRow, setHeaderRow] = useState(guessRow);
  const cols = sample[headerRow] ?? header;
  const [name, setName] = useState('');
  const [map, setMap] = useState<Partial<Record<ColField, number>>>({});
  const [dateFormat, setDateFormat] = useState(''); // '' = the host works it out
  const [decimal, setDecimal] = useState<fin.ProfileMapping['decimal']>('auto');
  const [invertSign, setInvertSign] = useState(false);
  const [currencyDefault, setCurrencyDefault] = useState('EUR');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const hasAmount = map.amount != null || (map.debit != null && map.credit != null);
  const ok = name.trim() && map.bookedDate != null && map.description != null && hasAmount && (map.currency != null || /^[A-Z]{3}$/.test(currencyDefault)) && !busy;
  /** A column by its header name, or its index when the header cell is empty. */
  const col = (i: number | undefined): fin.Col | undefined => (i == null ? undefined : cols[i]?.trim() ? cols[i].trim() : i);

  const save = async () => {
    if (!ok) return;
    setBusy(true);
    setMsg(null);
    try {
      const key = `user-${name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;
      const mapping: fin.ProfileMapping = {
        headerRow,
        bookedDate: col(map.bookedDate)!,
        description: [col(map.description)!],
        valueDate: col(map.valueDate),
        payee: col(map.payee),
        amount: col(map.amount),
        debit: map.amount == null ? col(map.debit) : undefined,
        credit: map.amount == null ? col(map.credit) : undefined,
        fee: col(map.fee),
        currency: col(map.currency),
        balance: col(map.balance),
        bankCategory: col(map.bankCategory),
        dateFormat: dateFormat || undefined,
        decimal,
        invertSign,
        currencyDefault: map.currency == null ? currencyDefault : undefined,
        institution: name.trim(),
      };
      onSaved(await fin.saveProfile({ key, name: name.trim(), mapping }));
    } catch (e) {
      setMsg(errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="g-card p-5 space-y-3">
      <div className="g-stitle">Columns</div>
      <p className={`text-sm ${MUTED}`}>Say which row holds the column names, and which column holds what. Use one signed amount column, or a money-out and a money-in column.</p>
      {sample.length > 0 && (
        <label className="block">
          <span className="g-flbl">Header row</span>
          <select className="g-field g-field-sm" value={headerRow} onChange={(e) => { setHeaderRow(Number(e.target.value)); setMap({}); }}>
            {sample.slice(0, 15).map((r, i) => (
              <option key={i} value={i}>
                {i + 1}: {r.filter(Boolean).join(' · ').slice(0, 90) || '(empty)'}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))' }}>
        {FIELDS.map((f) => (
          <label key={f.key} className="block">
            <span className="g-flbl">
              {f.label}
              {f.required ? ' *' : ''}
            </span>
            <select className="g-field g-field-sm" value={map[f.key] ?? ''} onChange={(e) => setMap((c) => ({ ...c, [f.key]: e.target.value === '' ? undefined : Number(e.target.value) }))}>
              <option value="">—</option>
              {cols.map((h, i) => (
                <option key={i} value={i}>
                  {h?.trim() || `Column ${i + 1}`}
                </option>
              ))}
            </select>
          </label>
        ))}
        <label className="block">
          <span className="g-flbl">Date format</span>
          <select className="g-field g-field-sm" value={dateFormat} onChange={(e) => setDateFormat(e.target.value)}>
            {[
              ['', 'Work it out'],
              ['%d/%m/%Y', 'DD/MM/YYYY'],
              ['%m/%d/%Y', 'MM/DD/YYYY'],
              ['%Y-%m-%d', 'YYYY-MM-DD'],
              ['%d.%m.%Y', 'DD.MM.YYYY'],
            ].map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="g-flbl">Decimal mark</span>
          <select className="g-field g-field-sm" value={decimal} onChange={(e) => setDecimal(e.target.value as fin.ProfileMapping['decimal'])}>
            <option value="auto">Work it out</option>
            <option value="comma">Comma (12,50)</option>
            <option value="dot">Point (12.50)</option>
          </select>
        </label>
        {map.currency == null && (
          <label className="block">
            <span className="g-flbl">Currency of the file</span>
            <input className="g-field g-field-sm uppercase" maxLength={3} value={currencyDefault} onChange={(e) => setCurrencyDefault(e.target.value.toUpperCase())} />
          </label>
        )}
      </div>
      <label className={`flex items-center gap-2 text-sm ${MUTED}`}>
        <input type="checkbox" checked={invertSign} onChange={(e) => setInvertSign(e.target.checked)} /> Spending shows as positive in this file
      </label>
      <div className="flex flex-wrap items-end gap-3">
        <label className="block flex-1 min-w-[200px]">
          <span className="g-flbl">Name this bank's format</span>
          <input className="g-field g-field-sm" value={name} onChange={(e) => setName(e.target.value)} placeholder="My bank" />
        </label>
        <button className="g-btn g-btn-gilt" disabled={!ok} onClick={() => void save()}>
          Save and preview
        </button>
      </div>
      {msg && <p className="text-sm text-error">{msg}</p>}
    </div>
  );
}

/** An import on its way: the stage, rows done of the total, and the bar. */
function Running({ job }: { job: fin.ImportJob }) {
  const { locale } = useFinance();
  const pct = progressPercent(job);
  const fmt = (n: number) => new Intl.NumberFormat(locale).format(n);
  return (
    <div className="g-card g-corners p-5 space-y-3" aria-live="polite">
      <div className="flex items-baseline justify-between gap-3">
        <div className="g-stitle truncate">Importing {job.file_name || 'the file'}</div>
        <span className={`text-sm tabular-nums ${MUTED}`}>{pct}%</span>
      </div>
      <div className="g-pbar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
        <span style={{ width: `${pct}%` }} />
      </div>
      <p className="text-sm text-text tabular-nums">{stageLabel(job, fmt)}</p>
      <p className={`text-xs ${MUTED}`}>The import runs on the host: you can leave this screen and come back.</p>
    </div>
  );
}

function Result({ result, onAgain }: { result: fin.ImportResult; onAgain: () => void }) {
  const { goto } = useFinance();
  const items: [string, number][] = [
    ['new', result.created],
    ['already there', result.duplicates],
    ['sorted by rules', result.categorised_by_rules],
    ['transfers matched', result.paired],
    ['to review', result.review],
    ['refunds matched', result.refunds ?? 0],
    ...(result.posted ? ([['posted straight away', result.posted]] as [string, number][]) : []),
  ];
  return (
    <div className="g-card g-corners p-5 space-y-4">
      <div className="g-stitle">Imported</div>
      <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))' }}>
        {items.map(([label, n]) => (
          <div key={label} className="g-inset px-3 py-2">
            <div className="text-2xl text-text tabular-nums">{n}</div>
            <div className={`text-xs ${MUTED}`}>{label}</div>
          </div>
        ))}
      </div>
      {(result.warnings ?? []).map((w, i) => (
        <p key={i} className="text-sm g-tag g-tag-warn !rounded !py-1 !h-auto">
          {w}
        </p>
      ))}
      <div className="flex flex-wrap gap-2">
        <button className="g-btn g-btn-pri" onClick={() => goto('transactions')}>
          Sort the inbox
        </button>
        <button className="g-btn g-btn-ghost" onClick={onAgain}>
          Import another
        </button>
      </div>
    </div>
  );
}

/** Transfers the matcher wasn't sure of: both sides, and a yes or no, one by one or in bulk. */
function ReviewList() {
  const { accountByLedger, locale, reload, reviewCount } = useFinance();
  const [pairs, setPairs] = useState<fin.Pair[] | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [bar, setBar] = useState(String(AUTO_PERCENT));
  const [busy, setBusy] = useState(false);
  const rescored = useRef(false);

  useEffect(() => {
    // Once per visit, the waiting pairs get another look with the current rules first.
    const first = !rescored.current;
    rescored.current = true;
    let stale = false;
    (first ? fin.rescorePairs() : Promise.resolve(null))
      .catch(() => null)
      .then((r) => {
        if (r?.confirmed) void reload();
        return fin.listPairs('review');
      })
      .then((ps) => {
        if (!stale) setPairs(ps);
      })
      .catch((e) => setMsg(errText(e)));
    return () => {
      stale = true;
    };
  }, [reviewCount, reload]);

  const resolve = async (p: fin.Pair, accept: boolean) => {
    try {
      await fin.resolvePair(p.id, accept);
      setPairs((ps) => (ps ?? []).filter((x) => x.id !== p.id));
      void reload();
    } catch (e) {
      setMsg(errText(e));
    }
  };

  /** "Same money" for many pairs in one call, after saying how many. */
  const acceptMany = async (chosen: fin.Pair[], what: string) => {
    if (!chosen.length) return;
    const n = chosen.length;
    if (!(await confirmDialog(`Mark ${n} ${n === 1 ? 'pair' : 'pairs'} ${what} as the same money?`))) return;
    setBusy(true);
    try {
      const r = await fin.resolvePairs(chosen.map((p) => p.id), true);
      setMsg(r.skipped ? `${r.skipped} skipped: they changed since. Pair those by hand.` : null);
      setPairs(await fin.listPairs('review'));
      void reload();
    } catch (e) {
      setMsg(errText(e));
    } finally {
      setBusy(false);
    }
  };

  if (!pairs?.length && !msg) return null;
  const likeCount = new Map<string, number>();
  for (const p of pairs ?? []) likeCount.set(p.like_key, (likeCount.get(p.like_key) ?? 0) + 1);
  const atBar = pairsAtLeast(pairs ?? [], clampPercent(bar));
  const side = (e: fin.Entry) => {
    const { bank, account } = splitEntry(e, accountByLedger);
    return (
      <div className="flex items-center gap-3 text-sm min-w-0">
        <span className={`w-[96px] shrink-0 ${MUTED}`}>{formatDate(e.date, locale)}</span>
        <span className="flex-1 min-w-0 truncate">
          <span className="text-text">{account?.name ?? '—'}</span>
          <span className={MUTED}> · {e.payee || e.description}</span>
        </span>
        {bank && <Money minor={bank.amount_minor} currency={bank.currency} colour />}
      </div>
    );
  };
  return (
    <section className="space-y-3">
      <DecoHeading count={pairs?.length ?? 0}>To review</DecoHeading>
      {msg && <p className="text-sm text-error">{msg}</p>}
      {!!pairs?.length && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <label className="flex items-center gap-2">
            <span className={MUTED}>Accept all at ≥</span>
            <input
              type="number"
              min={0}
              max={100}
              className="g-field tabular-nums w-[72px]"
              value={bar}
              onChange={(e) => setBar(e.target.value)}
              aria-label="Lowest match to accept, in percent"
            />
            <span className={MUTED}>%</span>
          </label>
          <button
            className="g-btn g-btn-gilt g-btn-sm"
            disabled={busy || !atBar.length}
            onClick={() => void acceptMany(atBar, `at ${clampPercent(bar)}% or more`)}
          >
            Accept {atBar.length}
          </button>
        </div>
      )}
      {pairs?.length === 0 ? (
        <Empty title="Nothing to review" />
      ) : (
        pairs?.map((p) => (
          <div key={p.id} className="g-card p-4 space-y-2">
            <div className="flex items-center gap-2">
              <span className="g-tag g-tag-warn">{p.kind === 'fx' ? 'Exchange?' : 'Transfer?'}</span>
              <span className={`text-xs ${MUTED}`}>Match {Math.round(p.score * 100)}%</span>
            </div>
            {side(p.entry_a)}
            {side(p.entry_b)}
            <div className="flex flex-wrap gap-2 justify-end">
              {(likeCount.get(p.like_key) ?? 0) > 1 && (
                <button
                  className="g-btn g-btn-ghost g-btn-sm"
                  disabled={busy}
                  onClick={() => void acceptMany(pairsLike(pairs ?? [], p), 'like this one')}
                >
                  Same money for all like this ({likeCount.get(p.like_key)})
                </button>
              )}
              <button className="g-btn g-btn-ghost g-btn-sm" onClick={() => void resolve(p, false)}>
                Not a transfer
              </button>
              <button className="g-btn g-btn-gilt g-btn-sm" onClick={() => void resolve(p, true)}>
                Same money
              </button>
            </div>
          </div>
        ))
      )}
    </section>
  );
}
