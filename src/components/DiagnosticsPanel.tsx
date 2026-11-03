import { useState } from 'react';
import { getDiagnostics, fetchHostLog, hasDaemon, isTauri, isDesktopOnline, getDaemonBaseUrl, DaemonError, type DiagnosticsBundle } from '../lib/daemon';
import { getClientLog, clearClientLog } from '../lib/errorLog';

/** Settings → Report a bug. Gathers a redacted, read-only diagnostics bundle
 * from the host plus this client's recent error buffer, lets the user add a
 * description, and copy or download the result. Nothing is ever auto-uploaded. */
export default function DiagnosticsPanel() {
  const [desc, setDesc] = useState('');
  const [bundle, setBundle] = useState<DiagnosticsBundle | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // A calm notice (host on an older build, owner-only) vs a real error — styled
  // differently so the "host not updated yet" case doesn't read like a failure.
  const [errTone, setErrTone] = useState<'error' | 'notice'>('error');
  const [copied, setCopied] = useState(false);
  const clientLog = getClientLog();

  // Whose logs are these? When the desktop is a client of a remote host (online
  // mode), "Gather diagnostics" pulls the HOST's server logs — not this device's.
  // Make that explicit so a remote admin isn't confused by their own local logs.
  const base = getDaemonBaseUrl();
  const hostIsLocal = isTauri() && !isDesktopOnline();
  const hostLabel = hostIsLocal ? 'this machine' : base || 'the connected host';

  const gather = async () => {
    setLoading(true);
    setErr(null);
    try {
      setBundle(await getDiagnostics());
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const code = e instanceof DaemonError ? e.code : undefined;
      if (code === 'ENDPOINT_MISSING') {
        setErrTone('notice');
        setErr('This host is on an older build — host diagnostics will appear once it’s rebuilt & restarted. Your client errors below are still captured.');
      } else if (/forbidden|owner-only/i.test(msg)) {
        setErrTone('notice');
        setErr('Host diagnostics are owner-only — open this on the host machine. Your client errors below are still included.');
      } else {
        setErrTone('error');
        setErr(`Couldn’t reach the host: ${msg}`);
      }
    } finally {
      setLoading(false);
    }
  };

  const buildReport = (): string => {
    const lines: string[] = [];
    lines.push('# Ganban bug report');
    lines.push(`Generated: ${new Date().toISOString()}`);
    lines.push('');
    lines.push('## Description');
    lines.push(desc.trim() || '(none provided)');
    lines.push('');
    lines.push('## Environment');
    lines.push(`- Connected host: ${hostLabel}${hostIsLocal ? ' (this device is the host)' : ''}`);
    lines.push(`- User agent: ${navigator.userAgent}`);
    if (bundle) {
      lines.push(`- Server version: ${bundle.app.server_version}`);
      lines.push(`- Platform: ${bundle.platform.os}/${bundle.platform.arch} (${bundle.platform.family})`);
      lines.push(`- Host uptime: ${fmtUptime(bundle.uptime_secs)}`);
      if (bundle.log_dir) lines.push(`- Log dir: ${bundle.log_dir}`);
    } else {
      lines.push('- Host diagnostics: not gathered');
    }
    lines.push('');
    lines.push(`## Recent client errors (this device) (${clientLog.length})`);
    if (clientLog.length === 0) lines.push('(none)');
    for (const e of clientLog) {
      lines.push(`- [${e.t}] ${e.level.toUpperCase()}: ${e.message}`);
      if (e.stack) lines.push(`    ${e.stack.split('\n').slice(0, 4).join('\n    ')}`);
    }
    lines.push('');
    if (bundle) {
      lines.push('## Server log (tail)');
      lines.push('```');
      lines.push(bundle.server_log_tail || '(empty)');
      lines.push('```');
      lines.push('');
      for (const eng of bundle.engine_logs) {
        lines.push(`## Engine log — ${eng.name}`);
        lines.push('```');
        lines.push(eng.tail || '(empty)');
        lines.push('```');
        lines.push('');
      }
      lines.push(`## Recent agent actions (${bundle.ledger_recent.length})`);
      for (const a of bundle.ledger_recent) {
        const cost = a.completion_tokens ? ` · ${a.completion_tokens}tok` : '';
        lines.push(`- [${a.at}] ${a.status} ${a.tool}${a.model ? ` (${a.model})` : ''}${cost} — ${a.summary}`);
      }
      lines.push('');
    }
    lines.push('---');
    lines.push('Assembled locally; redacted host-side. Review before sharing.');
    return lines.join('\n');
  };

  const copyReport = async () => {
    try {
      await navigator.clipboard.writeText(buildReport());
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setErr('Could not copy to clipboard.');
    }
  };

  // Download a full (redacted) host log file: newest server log, or a named one.
  const downloadHostLog = async (file?: string) => {
    try {
      const { name, text } = await fetchHostLog(file);
      const blob = new Blob([text], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    } catch (e) {
      const code = e instanceof DaemonError ? e.code : undefined;
      setErrTone(code === 'ENDPOINT_MISSING' ? 'notice' : 'error');
      setErr(code === 'ENDPOINT_MISSING'
        ? 'Full-log download needs the host on the current build (rebuild & restart it).'
        : `Couldn’t download the host log: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const downloadReport = () => {
    const blob = new Blob([buildReport()], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ganban-bug-report-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.txt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  };

  const cardCls = 'g-card p-5 space-y-3';
  const preCls = 'text-[11px] font-mono whitespace-pre-wrap break-words g-inset p-2 max-h-64 overflow-y-auto text-subtext-1';

  return (
    <div className="space-y-5">
      <h3 className="g-h2 justify-start mb-1">Report a bug</h3>
      <p className="text-sm text-subtext-0">
        Gather a <span className="text-text">redacted, read-only</span> snapshot — host logs, recent
        agent actions, and this app's recent errors — then copy or save it to share. Nothing is sent
        automatically.
      </p>
      <div className="text-xs text-subtext-1 g-inset px-3 py-2">
        Server logs come from <span className="text-text">{hostLabel}</span>
        {hostIsLocal ? ' (this device is the host)' : ' — the host you’re connected to'}.
        The <span className="text-text">client errors</span> below are from <span className="text-text">this device</span>.
      </div>

      <div className={cardCls}>
        <label className="block text-xs text-subtext-0">What happened? Steps to reproduce?</label>
        <textarea
          value={desc}
          onChange={(e) => setDesc(e.target.value)}
          rows={4}
          placeholder="e.g. Clicked Approve on a proposal and the app froze. Repro: …"
          className="w-full bg-surface-0 border border-surface-2 rounded-lg px-3 py-2 text-sm text-text resize-y"
        />
        <div className="flex flex-wrap gap-2">
          <button
            onClick={gather}
            disabled={loading || !hasDaemon()}
            className="g-btn g-btn-ghost"
          >
            {loading ? 'Gathering…' : bundle ? 'Refresh diagnostics' : 'Gather diagnostics'}
          </button>
          <button onClick={copyReport} className="g-btn g-btn-pri">
            {copied ? 'Copied ✓' : 'Copy report'}
          </button>
          <button onClick={downloadReport} className="g-btn g-btn-ghost">
            Download
          </button>
          {clientLog.length > 0 && (
            <button onClick={() => { clearClientLog(); setCopied(false); }} className="px-4 py-2 text-sm text-subtext-0 hover:text-text ml-auto">
              Clear client log ({clientLog.length})
            </button>
          )}
        </div>
        {err && <div className={`text-sm ${errTone === 'notice' ? 'text-subtext-0' : 'text-warning'}`}>{err}</div>}
      </div>

      {bundle && (
        <div className={cardCls}>
          <div className="font-medium text-text">Host — <span className="font-normal text-subtext-1">{hostLabel}</span></div>
          <div className="text-sm text-subtext-1 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
            <span>Server version</span><span className="text-text">{bundle.app.server_version}</span>
            <span>Platform</span><span className="text-text">{bundle.platform.os}/{bundle.platform.arch}</span>
            <span>Uptime</span><span className="text-text">{fmtUptime(bundle.uptime_secs)}</span>
            {bundle.log_dir && (<><span>Log dir</span><span className="text-text break-all font-mono text-[11px]">{bundle.log_dir}</span></>)}
          </div>
          {!hostIsLocal && (
            <p className="text-[11px] text-subtext-0">These files live on the host machine — use “Download full” to pull the complete file here.</p>
          )}
          <details>
            <summary className="text-sm text-subtext-0 cursor-pointer">Server log (tail)</summary>
            <div className="flex justify-end mt-1">
              <button onClick={() => void downloadHostLog()} className="text-xs text-primary hover:underline">Download full log</button>
            </div>
            <pre className={preCls}>{bundle.server_log_tail || '(empty)'}</pre>
          </details>
          {bundle.engine_logs.map((eng) => (
            <details key={eng.name}>
              <summary className="text-sm text-subtext-0 cursor-pointer">Engine log — {eng.name}</summary>
              <div className="flex justify-end mt-1">
                <button onClick={() => void downloadHostLog(eng.name)} className="text-xs text-primary hover:underline">Download full log</button>
              </div>
              <pre className={preCls}>{eng.tail || '(empty)'}</pre>
            </details>
          ))}
          <details>
            <summary className="text-sm text-subtext-0 cursor-pointer">Recent agent actions ({bundle.ledger_recent.length})</summary>
            <pre className={preCls}>
              {bundle.ledger_recent.map((a) => `[${a.at}] ${a.status} ${a.tool} — ${a.summary}`).join('\n') || '(none)'}
            </pre>
          </details>
        </div>
      )}

      <div className={cardCls}>
        <details open={!bundle}>
          <summary className="text-sm text-subtext-0 cursor-pointer">This device (client) — recent errors ({clientLog.length})</summary>
          <pre className={preCls}>
            {clientLog.map((e) => `[${e.t}] ${e.level.toUpperCase()}: ${e.message}`).join('\n') || '(none captured this session)'}
          </pre>
        </details>
      </div>

      {!isTauri() && (
        <p className="text-xs text-subtext-0">On a phone/browser client, host log files aren't reachable — the report still includes server diagnostics (if you're the owner) and this client's errors.</p>
      )}
    </div>
  );
}

function fmtUptime(secs: number): string {
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`;
  return `${Math.floor(secs / 86400)}d ${Math.floor((secs % 86400) / 3600)}h`;
}
