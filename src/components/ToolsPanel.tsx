import { useEffect, useState } from 'react';
import { confirmDialog } from '../lib/confirm';
import ScrollArea from './ScrollArea';
import {
  getToolCatalog,
  currentDaemonUrl,
  listRegistryTools,
  getRegistryBindings,
  createRegistryTool,
  setRegistryToolEnabled,
  deleteRegistryTool,
  listConnectorSecrets,
  setConnectorSecret,
  deleteConnectorSecret,
  DaemonError,
  type ToolCatalog,
  type ToolInfo,
  type RegistryTool,
  type RegistryBindings,
} from '../lib/daemon';

/** Owner-only management of declarative ("registry") tools — define a tool as
 * data (v1: a safe, allowlisted read command), no redeploy. New tools join the
 * catalog above and the chat tool loop, through the same gate. */
function RegistryManager({ onChanged }: { onChanged: () => void }) {
  const [tools, setTools] = useState<RegistryTool[]>([]);
  const [bindings, setBindings] = useState<RegistryBindings | null>(null);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [kind, setKind] = useState<'ops' | 'rag' | 'mcp' | 'http' | 'fetch'>('ops');
  const [fetchExtract, setFetchExtract] = useState<'text' | 'raw'>('text');
  const [command, setCommand] = useState('');
  const [limit, setLimit] = useState('8');
  const [filters, setFilters] = useState('');
  const [mcpMount, setMcpMount] = useState('');
  const [mcpTool, setMcpTool] = useState('');
  const [httpUrl, setHttpUrl] = useState('');
  const [httpQuery, setHttpQuery] = useState('');
  const [httpHeaders, setHttpHeaders] = useState('');
  const [httpSecret, setHttpSecret] = useState('');
  const [httpPath, setHttpPath] = useState('');
  const [httpFields, setHttpFields] = useState('');
  const [httpMethod, setHttpMethod] = useState<'GET' | 'POST'>('GET');
  const [httpBody, setHttpBody] = useState('');
  const [secrets, setSecrets] = useState<string[]>([]);
  const [newSecretName, setNewSecretName] = useState('');
  const [newSecretValue, setNewSecretValue] = useState('');

  const load = async () => {
    try {
      const [t, b, s] = await Promise.all([listRegistryTools(), getRegistryBindings(), listConnectorSecrets()]);
      setTools(t);
      setBindings(b);
      setSecrets(s);
      if (!command && b.ops_commands[0]) setCommand(b.ops_commands[0]);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = async () => {
    if (!name.trim()) return;
    let binding_json: string;
    let params_json: string | undefined;
    if (kind === 'ops') {
      if (!command) return;
      binding_json = JSON.stringify({ command });
    } else if (kind === 'mcp') {
      if (!mcpMount || !mcpTool) return;
      binding_json = JSON.stringify({ mount: mcpMount, tool: mcpTool });
      params_json = JSON.stringify({ type: 'object', properties: { query: { type: 'string', description: 'What to ask the engine.' } }, required: ['query'] });
    } else if (kind === 'http') {
      if (!httpUrl.trim()) return;
      const b: Record<string, unknown> = { url: httpUrl.trim() };
      for (const [k, raw] of [['query', httpQuery], ['headers', httpHeaders]] as const) {
        if (raw.trim()) {
          try {
            b[k] = JSON.parse(raw);
          } catch {
            setErr(`${k} must be valid JSON (e.g. {"q":"{query}"}).`);
            return;
          }
        }
      }
      if (httpMethod === 'POST') {
        b.method = 'POST';
        if (httpBody.trim()) {
          try {
            b.body = JSON.parse(httpBody);
          } catch {
            setErr('Body must be valid JSON (e.g. {"url":"{query}","formats":["markdown"]}).');
            return;
          }
        }
      }
      if (httpSecret) b.secret_name = httpSecret;
      if (httpPath.trim()) {
        const fields = httpFields.split(',').map((s) => s.trim()).filter(Boolean);
        b.select = { path: httpPath.trim(), limit: 5, ...(fields.length ? { fields } : {}) };
      }
      binding_json = JSON.stringify(b);
      params_json = JSON.stringify({ type: 'object', properties: { query: { type: 'string', description: 'The lookup value (use {query} in the template).' } }, required: ['query'] });
    } else if (kind === 'fetch') {
      binding_json = JSON.stringify({ extract: fetchExtract });
      params_json = JSON.stringify({ type: 'object', properties: { url: { type: 'string', description: 'The http(s) URL of the page to fetch.' } }, required: ['url'] });
    } else {
      // rag: the model supplies `query`; the owner presets limit/filters.
      let f: Record<string, unknown> | undefined;
      if (filters.trim()) {
        try {
          f = JSON.parse(filters);
        } catch {
          setErr('Filters must be valid JSON (e.g. {"format":"pdf"}).');
          return;
        }
      }
      binding_json = JSON.stringify({ limit: Math.max(1, Math.min(50, Number(limit) || 8)), ...(f ? { filters: f } : {}) });
      params_json = JSON.stringify({ type: 'object', properties: { query: { type: 'string', description: 'What to search for.' } }, required: ['query'] });
    }
    setBusy(true);
    setErr(null);
    try {
      await createRegistryTool({ name: name.trim(), description: description.trim(), binding_kind: kind, binding_json, params_json, class: 'read' });
      setName('');
      setDescription('');
      setFilters('');
      setAdding(false);
      await load();
      onChanged();
    } catch (e) {
      setErr(e instanceof DaemonError ? e.message : e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (t: RegistryTool) => {
    await setRegistryToolEnabled(t.id, !t.enabled).catch(() => {});
    await load();
    onChanged();
  };
  const remove = async (t: RegistryTool) => {
    if (!(await confirmDialog(`Delete the custom tool “${t.name}”?`))) return;
    await deleteRegistryTool(t.id).catch(() => {});
    await load();
    onChanged();
  };
  // A short label for what a tool is bound to (command, or rag search).
  const bindingLabel = (t: RegistryTool): string => {
    try {
      const b = JSON.parse(t.binding_json);
      if (t.binding_kind === 'rag') return 'corpus search';
      if (t.binding_kind === 'mcp') return `mcp · ${b.tool ?? ''}`;
      if (t.binding_kind === 'http') {
        try {
          return `http · ${new URL(b.url).host}`;
        } catch {
          return 'http';
        }
      }
      if (t.binding_kind === 'fetch') return 'fetch page';
      return (b.command as string) ?? t.binding_kind;
    } catch {
      return t.binding_kind;
    }
  };
  const mcpMounts = bindings?.mcp_mounts ?? [];
  const toolsForMount = mcpMounts.find((m) => m.mount === mcpMount)?.tools ?? [];

  const addSecret = async () => {
    if (!newSecretName.trim() || !newSecretValue) return;
    await setConnectorSecret(newSecretName.trim(), newSecretValue).catch((e) => setErr(String(e)));
    setNewSecretName('');
    setNewSecretValue('');
    await load();
  };
  const removeSecret = async (n: string) => {
    if (!(await confirmDialog(`Delete connector secret “${n}”?`))) return;
    await deleteConnectorSecret(n).catch(() => {});
    await load();
  };

  const fieldClass = 'g-field g-field-sm';

  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="g-flbl">
          Custom tools <span className="text-subtext-0/70">· {tools.length}</span>
        </h3>
        <button
          onClick={() => setAdding((v) => !v)}
          className="text-xs text-primary hover:text-primary-hover"
        >
          {adding ? 'Cancel' : '+ New tool'}
        </button>
      </div>
      <p className="text-[11px] text-subtext-0 -mt-1">
        Define a tool as data, bound to a safe read command — no redeploy. It joins the catalog and chat through the same
        gate.
      </p>

      {adding && (
        <div className="bg-surface-1 rounded-lg p-3 space-y-2">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="tool_name (letters/digits/_)" className={fieldClass} />
          <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Description (what it does / when to use it)" className={fieldClass} />
          <label className="flex items-center gap-2 text-xs text-subtext-1">
            <span className="shrink-0">Binding</span>
            <select
              value={kind}
              onChange={(e) => {
                const k = e.target.value as 'ops' | 'rag' | 'mcp' | 'http' | 'fetch';
                setKind(k);
                if (k === 'mcp' && !mcpMount && mcpMounts[0]) {
                  setMcpMount(mcpMounts[0].mount);
                  setMcpTool(mcpMounts[0].tools[0] ?? '');
                }
              }}
              className={fieldClass}
            >
              <option value="ops">ops · read command</option>
              <option value="rag">rag · corpus search</option>
              <option value="mcp" disabled={mcpMounts.length === 0}>
                mcp · engine tool{mcpMounts.length === 0 ? ' (engine offline)' : ''}
              </option>
              <option value="http">http · connector (fixed API)</option>
              <option value="fetch">fetch · page (model's URL)</option>
            </select>
          </label>
          {kind === 'ops' ? (
            <>
              <label className="flex items-center gap-2 text-xs text-subtext-1">
                <span className="shrink-0">Command</span>
                <select value={command} onChange={(e) => setCommand(e.target.value)} className={fieldClass}>
                  {(bindings?.ops_commands ?? []).map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
              </label>
              <p className="text-[11px] text-subtext-0">Runs scope-forced to the current project; no extra model arguments in this version.</p>
            </>
          ) : kind === 'mcp' ? (
            <>
              <label className="flex items-center gap-2 text-xs text-subtext-1">
                <span className="shrink-0">Mount</span>
                <select
                  value={mcpMount}
                  onChange={(e) => {
                    setMcpMount(e.target.value);
                    setMcpTool(mcpMounts.find((m) => m.mount === e.target.value)?.tools[0] ?? '');
                  }}
                  className={fieldClass}
                >
                  {mcpMounts.map((m) => (
                    <option key={m.mount} value={m.mount}>{m.mount}</option>
                  ))}
                </select>
              </label>
              <label className="flex items-center gap-2 text-xs text-subtext-1">
                <span className="shrink-0">Tool</span>
                <select value={mcpTool} onChange={(e) => setMcpTool(e.target.value)} className={fieldClass}>
                  {toolsForMount.map((t) => (
                    <option key={t} value={t}>{t}</option>
                  ))}
                </select>
              </label>
              <p className="text-[11px] text-subtext-0">Brokered through ragrat. <span className="text-warning">Owner-only</span> in chat (it can reach any mounted collection); the model supplies the <span className="font-mono">query</span>.</p>
            </>
          ) : kind === 'http' ? (
            <>
              <div className="flex gap-2">
                <select value={httpMethod} onChange={(e) => setHttpMethod(e.target.value as 'GET' | 'POST')} className={`${fieldClass} w-24`}>
                  <option value="GET">GET</option>
                  <option value="POST">POST</option>
                </select>
                <input value={httpUrl} onChange={(e) => setHttpUrl(e.target.value)} placeholder="https://api.example.com/search" className={fieldClass} />
              </div>
              {httpMethod === 'POST' && (
                <input value={httpBody} onChange={(e) => setHttpBody(e.target.value)} placeholder='Body JSON, e.g. {"url":"{query}","formats":["markdown"]}' className={fieldClass} />
              )}
              <input value={httpQuery} onChange={(e) => setHttpQuery(e.target.value)} placeholder='Query JSON (optional), e.g. {"q":"{query}","key":"{secret}"}' className={fieldClass} />
              <input value={httpHeaders} onChange={(e) => setHttpHeaders(e.target.value)} placeholder='Headers JSON (optional), e.g. {"Authorization":"Bearer {secret}"}' className={fieldClass} />
              <label className="flex items-center gap-2 text-xs text-subtext-1">
                <span className="shrink-0">Secret</span>
                <select value={httpSecret} onChange={(e) => setHttpSecret(e.target.value)} className={fieldClass}>
                  <option value="">— none —</option>
                  {secrets.map((s) => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              </label>
              <div className="flex gap-2">
                <input value={httpPath} onChange={(e) => setHttpPath(e.target.value)} placeholder="Results path (optional), e.g. web.results" className={fieldClass} />
                <input value={httpFields} onChange={(e) => setHttpFields(e.target.value)} placeholder="Fields, e.g. title,url,description" className={fieldClass} />
              </div>
              <p className="text-[11px] text-subtext-0">
                HTTPS only, fixed host (SSRF-guarded, no redirects). <span className="text-warning">Owner-only</span>; response is untrusted. Use <span className="font-mono">{'{query}'}</span> for the model's input and <span className="font-mono">{'{secret}'}</span> for the secret. A results path + fields trims the JSON to tidy rows.
              </p>
            </>
          ) : kind === 'fetch' ? (
            <>
              <label className="flex items-center gap-2 text-xs text-subtext-1">
                <span className="shrink-0">Returns</span>
                <select value={fetchExtract} onChange={(e) => setFetchExtract(e.target.value as 'text' | 'raw')} className={fieldClass}>
                  <option value="text">readable text (strip HTML)</option>
                  <option value="raw">raw body</option>
                </select>
              </label>
              <p className="text-[11px] text-subtext-0">
                The model supplies a <span className="font-mono">url</span>; Ganban GETs it (http/https, SSRF-guarded, redirects re-checked) and returns the page. <span className="text-warning">Owner-only</span>; result is untrusted. JS-rendered pages return their pre-render HTML only.
              </p>
            </>
          ) : (
            <>
              <label className="flex items-center gap-2 text-xs text-subtext-1">
                <span className="shrink-0">Results (1–50)</span>
                <input value={limit} onChange={(e) => setLimit(e.target.value)} inputMode="numeric" className={`${fieldClass} w-20`} />
              </label>
              <input value={filters} onChange={(e) => setFilters(e.target.value)} placeholder='Preset filters JSON (optional), e.g. {"format":"pdf"}' className={fieldClass} />
              <p className="text-[11px] text-subtext-0">Searches the current project's corpus; the model supplies the <span className="font-mono">query</span>.</p>
            </>
          )}
          <div className="flex justify-end">
            <button onClick={submit} disabled={busy || !name.trim()} className="g-btn g-btn-pri g-btn-sm">
              {busy ? 'Creating…' : 'Create'}
            </button>
          </div>
        </div>
      )}

      {err && <p className="text-xs text-error">{err}</p>}

      {tools.length > 0 && (
        <div className="space-y-1.5">
          {tools.map((t) => (
            <div key={t.id} className="bg-surface-1 rounded-lg px-3 py-2 flex items-center gap-3">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-xs text-text break-all">{t.name}</span>
                  <span className="g-tag shrink-0 font-mono">{bindingLabel(t)}</span>
                  {!t.enabled && <span className="g-tag shrink-0">off</span>}
                </div>
                {t.description && <p className="text-[11px] text-subtext-0 truncate">{t.description}</p>}
              </div>
              <button onClick={() => toggle(t)} className="shrink-0 text-[11px] text-subtext-0 hover:text-text">{t.enabled ? 'Disable' : 'Enable'}</button>
              <button onClick={() => remove(t)} className="shrink-0 text-[11px] text-error/80 hover:text-error">Delete</button>
            </div>
          ))}
        </div>
      )}

      {/* Connector secrets (for the http binding). Names only — values are
          write-only and never returned by the API. */}
      <div className="pt-2 mt-1 border-t border-surface-2 space-y-1.5">
        <div className="text-[11px] text-subtext-0">Connector secrets (API keys for http tools — referenced by name, never shown again)</div>
        {secrets.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {secrets.map((s) => (
              <span key={s} className="g-tag">
                <span className="font-mono">{s}</span>
                <button onClick={() => removeSecret(s)} className="text-error/70 hover:text-error" title="Delete">×</button>
              </span>
            ))}
          </div>
        )}
        <div className="flex gap-2">
          <input value={newSecretName} onChange={(e) => setNewSecretName(e.target.value)} placeholder="secret name" className={`${fieldClass} w-40`} />
          <input value={newSecretValue} onChange={(e) => setNewSecretValue(e.target.value)} placeholder="value" type="password" className={fieldClass} />
          <button onClick={addSecret} disabled={!newSecretName.trim() || !newSecretValue} className="g-btn g-btn-ghost g-btn-sm shrink-0">Add</button>
        </div>
      </div>
    </section>
  );
}

/** A human label + dot colour for where a tool comes from. */
function sourceLabel(source: string): string {
  if (source === 'builtin') return 'Built-in';
  if (source.startsWith('tab:')) return `Tab · ${source.slice(4)}`;
  return source;
}

function ToolRow({ tool }: { tool: ToolInfo }) {
  const [open, setOpen] = useState(false);
  const props = (tool.parameters?.properties ?? {}) as Record<string, { type?: string; description?: string }>;
  const required = (tool.parameters?.required ?? []) as string[];
  const paramNames = Object.keys(props);

  return (
    <div className="bg-surface-1 rounded-lg overflow-hidden">
      <button onClick={() => setOpen((v) => !v)} className="w-full flex items-start gap-3 p-3 text-left hover:bg-surface-2 transition-colors">
        <span className="shrink-0 mt-0.5 text-subtext-0">{open ? '▾' : '▸'}</span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-mono text-sm text-text break-all">{tool.name}</span>
            <span
              className={`shrink-0 text-[10px] px-1.5 py-0.5 rounded-full font-medium ${
                tool.class === 'write' ? 'bg-warning/20 text-warning' : 'bg-success/20 text-success'
              }`}
              title={tool.class === 'write' ? 'Gated: propose → approve → execute' : 'Reads execute immediately (scope-forced)'}
            >
              {tool.class === 'write' ? 'write · gated' : 'read'}
            </span>
            {tool.requires && (
              <span className="g-tag shrink-0" title="Only offered when this is enabled">
                needs {tool.requires}
              </span>
            )}
          </div>
          <p className="text-xs text-subtext-0 mt-0.5 break-words">{tool.description}</p>
        </div>
        <span className="shrink-0 text-[10px] text-subtext-0 mt-0.5">{sourceLabel(tool.source)}</span>
      </button>
      {open && (
        <div className="px-3 pb-3 pl-9 space-y-1">
          {paramNames.length === 0 ? (
            <p className="text-xs text-subtext-0">No arguments.</p>
          ) : (
            <table className="text-xs w-full">
              <tbody>
                {paramNames.map((p) => (
                  <tr key={p} className="align-top">
                    <td className="py-0.5 pr-3 font-mono text-text whitespace-nowrap">
                      {p}
                      {required.includes(p) && <span className="text-warning" title="required">*</span>}
                    </td>
                    <td className="py-0.5 pr-3 text-subtext-0 font-mono">{props[p]?.type ?? '—'}</td>
                    <td className="py-0.5 text-subtext-1">{props[p]?.description ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}

/** The knowledge engine card (owner-only): ragrat status, including the MCP
 * mounts it creates — so that surface is visible, not a black box. */
function EngineCard({ engine }: { engine: NonNullable<ToolCatalog['engine']> }) {
  if (!engine.configured) {
    return (
      <div className="bg-surface-1 rounded-lg p-3 text-sm text-subtext-0">
        No knowledge engine (ragrat) is configured on this host.
      </div>
    );
  }
  const s = (engine.status ?? {}) as Record<string, unknown>;
  const reachable = engine.status != null;
  const mounts = (s.mcp_mounts as string[] | undefined) ?? [];
  const collections = (s.collections_mounted as string[] | undefined) ?? [];
  const embedder = s.embedder as { model?: string; dimensions?: number; endpoint?: string } | undefined;

  return (
    <div className="bg-surface-1 rounded-lg p-3 space-y-2 text-sm">
      <div className="flex items-center gap-2">
        <span className={`inline-block w-2 h-2 rounded-full ${reachable ? 'bg-success' : 'bg-error'}`} />
        <span className="text-text font-medium">ragrat</span>
        {typeof s.version === 'string' && <span className="text-xs text-subtext-0">v{s.version}</span>}
        <span className="ml-auto text-xs font-mono text-subtext-0 break-all">{engine.base_url}</span>
      </div>
      {!reachable ? (
        <p className="text-xs text-subtext-0">Configured but unreachable right now (the engine may be stopped).</p>
      ) : (
        <>
          {embedder?.model && (
            <p className="text-xs text-subtext-1">
              <span className="text-subtext-0">Embedder: </span>
              <span className="font-mono">{embedder.model}</span>
              {embedder.dimensions ? ` · ${embedder.dimensions}d` : ''}
            </p>
          )}
          <div className="text-xs">
            <span className="text-subtext-0">Collections mounted ({collections.length}): </span>
            {collections.length ? <span className="font-mono text-subtext-1 break-all">{collections.join(', ')}</span> : <span className="text-subtext-0">none</span>}
          </div>
          <div className="text-xs">
            <span className="text-subtext-0">MCP mounts ({mounts.length}): </span>
            {mounts.length ? (
              <span className="font-mono text-subtext-1 break-all">{mounts.join('  ')}</span>
            ) : (
              <span className="text-subtext-0">none</span>
            )}
          </div>
          <p className="text-[11px] text-subtext-0">
            MCP mounts are ragrat's own tool surface for external clients; Ganban itself reaches ragrat through its control
            plane (search/ingest), surfaced above as the <span className="font-mono">search_corpus</span> /{' '}
            <span className="font-mono">ask_atlas</span> tools.
          </p>
          {engine.mcp_tools && engine.mcp_tools.length > 0 && (
            <div className="pt-1 space-y-1">
              <div className="text-xs text-subtext-0">MCP tools ({engine.mcp_tools.length}):</div>
              <div className="space-y-1">
                {engine.mcp_tools.map((t) => (
                  <div key={t.name} className="bg-surface-0 rounded px-2 py-1.5">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-xs text-text break-all">{t.name}</span>
                      <span className="g-tag shrink-0">via ragrat</span>
                    </div>
                    {t.description && (
                      <p className="text-[11px] text-subtext-1 mt-0.5 break-words line-clamp-2">{t.description.split('\n')[0]}</p>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** The Tools inspector: every agent tool this build offers (read + gated-write,
 * built-in + tab), grouped by source, plus the owner's knowledge-engine status.
 * Read-only — it lists what the assistant CAN do; it never runs anything. */
export default function ToolsPanel({ fill = true }: { fill?: boolean }) {
  const [catalog, setCatalog] = useState<ToolCatalog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      setCatalog(await getToolCatalog());
    } catch (e) {
      setError(e instanceof DaemonError ? e.message : e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const tools = catalog?.tools ?? [];
  const reads = tools.filter((t) => t.class === 'read');
  const writes = tools.filter((t) => t.class === 'write');

  return (
    <ScrollArea className={fill ? 'h-full w-full space-y-5' : 'space-y-5'}>
      <div className={fill ? 'max-w-3xl mx-auto w-full p-4 space-y-5' : 'space-y-5'}>
      <div className="flex items-center justify-between gap-2">
        {fill ? (
          <div>
            <h2 className="g-h2 justify-start mb-1">Tools</h2>
            <p className="text-xs text-subtext-0">
              Everything the assistant can do on this build. Reads run immediately (project-scoped); writes only ever
              create proposals you approve.
            </p>
          </div>
        ) : (
          <span className="text-xs text-subtext-0">{tools.length} tools</span>
        )}
        <button onClick={load} disabled={loading} className="g-btn g-btn-ghost g-btn-sm shrink-0">
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>

      {/* Which host answered, and its version — makes client/host skew obvious at
          a glance (the thing that turned a one-line fix into a goose chase). */}
      <p className="text-[11px] text-subtext-0 -mt-3">
        Connected to <span className="font-mono">{currentDaemonUrl() ?? '—'}</span>
        {catalog?.version ? <> · host <span className="font-mono">v{catalog.version}</span></> : null}
      </p>

      {error && <p className="text-sm text-error bg-error/10 border border-error/30 rounded-lg px-3 py-2">{error}</p>}

      {catalog && (
        <>
          {/* Owner-only: declarative-tool management (engine != null ⇒ owner). */}
          {catalog.engine != null && <RegistryManager onChanged={load} />}

          {catalog.engine && (
            <section className="space-y-2">
              <h3 className="g-flbl">Knowledge engine</h3>
              <EngineCard engine={catalog.engine} />
            </section>
          )}

          <section className="space-y-2">
            <h3 className="g-flbl">
              Read tools <span className="text-subtext-0/70">· {reads.length}</span>
            </h3>
            <div className="space-y-2">
              {reads.map((t) => (
                <ToolRow key={`${t.source}:${t.name}`} tool={t} />
              ))}
            </div>
          </section>

          <section className="space-y-2">
            <h3 className="g-flbl">
              Write tools (gated) <span className="text-subtext-0/70">· {writes.length}</span>
            </h3>
            <div className="space-y-2">
              {writes.map((t) => (
                <ToolRow key={`${t.source}:${t.name}`} tool={t} />
              ))}
            </div>
          </section>
        </>
      )}
      </div>
    </ScrollArea>
  );
}
