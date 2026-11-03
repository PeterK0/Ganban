import { useEffect, useMemo, useRef, useState } from 'react';
import { confirmDialog } from '../lib/confirm';
import {
  listOracleWorkflows,
  createOracleWorkflow,
  updateOracleWorkflow,
  deleteOracleWorkflow,
  runOracleWorkflow,
  cancelOracleRun,
  daemonInvoke,
  listProjectFiles,
  listProjectAttachments,
  DaemonError,
  type ProjectFile,
  type OracleWorkflow,
  type OracleDefinition,
  type OracleNode,
} from '../lib/daemon';
import { ASSISTANT_TREE_W } from '../lib/ui';
import type { Project, Task } from '../types';
import { nextRunLabel as scheduleLabel } from '../lib/schedule';
import { ORACLE_TEMPLATES, type OracleTemplate } from '../lib/oracleTemplates';

// --------------------------------------------------------------------------- //
// The node catalog (client mirror of the runner's compiled-in types). Category
// colors are the trust legend from the design mockups: amber = schedule,
// coral = untrusted outside content, teal = inside the walls, gate = gated
// writes. Capability truth lives server-side — this is presentation + params.
// --------------------------------------------------------------------------- //

type Cat = 'amber' | 'coral' | 'teal' | 'gate';
// Trust legend colours, from the theme (Gilt: no fixed hex).
const CAT_COLOR: Record<Cat, string> = { amber: 'var(--color-medium)', coral: 'var(--g-org)', teal: 'var(--g-teal)', gate: 'var(--color-primary)' };
/** A theme colour at `pct`% over transparent (stands in for hex-alpha suffixes). */
const tint = (col: string, pct: number) => `color-mix(in srgb, ${col} ${pct}%, transparent)`;
const runCol = (st: string) =>
  st === 'done' ? 'var(--color-success)' : st === 'failed' ? 'var(--color-error)' : st === 'running' ? 'var(--color-primary)' : st === 'frozen' ? 'var(--color-info)' : 'var(--color-overlay-0)';

interface ParamDef {
  key: string;
  label: string;
  placeholder: string;
  /** 'text' (default) | 'textarea' | 'project' (picker) | 'task' (picker,
   * scoped to the node's chosen project). Pickers exist so a write target is
   * a NAME you chose, never a bare id you guessed. */
  kind?: 'text' | 'textarea' | 'project' | 'task' | 'file' | 'quiztopic';
}
interface NodeDef {
  cat: Cat;
  icon: string;
  title: string;
  ty: string;
  desc: string;
  tag?: string;
  params: ParamDef[];
  hasIn: boolean;
  hasOut: boolean;
  note?: string;
}

const NODE_DEFS: Record<string, NodeDef> = {
  'trigger.manual': {
    cat: 'amber', icon: '▶', title: 'Manual trigger', ty: 'Trigger · manual',
    desc: 'Starts the run when you press “Run now”. A trigger has no input — it emits a control pulse downstream.',
    params: [], hasIn: false, hasOut: true,
  },
  'trigger.schedule': {
    cat: 'amber', icon: '⏱', title: 'Schedule', ty: 'Trigger · schedule',
    desc: 'Fires on the host\u2019s clock while the automation is LIVE (the ▶/⏸ toggle in the header). Cadences: “30 min”, “2 hours”, “1 day”, or a daily time like “07:00”. 5-minute floor; paused never fires.',
    params: [{ key: 'every', label: 'Every', placeholder: 'e.g. 1 hour · or 07:00 daily' }],
    hasIn: false, hasOut: true,
  },
  'fetch.http': {
    cat: 'coral', icon: '🌐', title: 'Fetch page', ty: 'Oracle · untrusted', tag: 'untrusted',
    desc: 'Pulls a page or feed from outside the perimeter (20s timeout, 512KB cap). Markup is stripped to readable TEXT by default — raw HTML wastes a model step\u2019s input window on tags. Everything it returns is untrusted from here on: it can flow into a model step as DATA, but nothing downstream lets it act.',
    params: [
      { key: 'url', label: 'URL', placeholder: 'https://…' },
      { key: 'format', label: 'Output (text = markup stripped, default · html = raw)', placeholder: 'text', kind: 'text' },
    ],
    hasIn: true, hasOut: true,
  },
  'file.read': {
    cat: 'teal', icon: '📄', title: 'Read project file', ty: 'Input · project file',
    desc: 'Reads a file stored in a project (e.g. a CSV dataset) into the workflow\u2019s memory — the input seam the coming Python nodes will machinate on. Text-capped; raise the cap for big captures (16–8192 KB).',
    params: [
      { key: 'project_id', label: 'Project', placeholder: '', kind: 'project' },
      { key: 'file_id', label: 'File', placeholder: '', kind: 'file' },
      { key: 'max_kb', label: 'Size cap (KB, default 1024)', placeholder: '1024', kind: 'text' },
    ],
    hasIn: true, hasOut: true,
  },
  'llm.transform': {
    cat: 'teal', icon: '📝', title: 'Model step', ty: 'Librarian · no tools', tag: 'no tools',
    desc: 'The one model call — summarize, extract, rewrite. Routed through the librarian protocol (your routing decides the model), ledgered like every run on this host. It holds NO tools, so hostile input can shape a value, never an action.',
    params: [
      { key: 'instruction', label: 'Instruction', placeholder: 'e.g. Summarize into 3 bullets with a source per claim…', kind: 'textarea' },
      { key: 'max_chars', label: 'Input cap (chars, default 24000)', placeholder: '24000', kind: 'text' },
    ],
    hasIn: true, hasOut: true,
  },
  'quiz.generate': {
    cat: 'gate', icon: '🎓', title: 'Generate quiz questions', ty: 'Write · needs approval', tag: 'needs approval',
    desc: 'Turns upstream content into quiz-bank questions and files them as batch proposals (25 per card; bigger hauls split). Per-question topics are honored — extract mode files each question under the lecture the material names, creating topics under the anchor\u2019s subject as needed. Mode "draft" authors new questions from study material; mode "extract" parses a PRE-AUTHORED bank (pasted markdown, exported lists) 1:1 — wording, answers, tolerances and sources preserved. Approval grows the bank; the node never writes directly.',
    params: [
      { key: 'project_id', label: 'Project', placeholder: '', kind: 'project' },
      { key: 'topic_id', label: 'Quiz topic', placeholder: '', kind: 'quiztopic' },
      { key: 'mode', label: 'Mode (draft = author new · extract = parse as-is)', placeholder: 'draft', kind: 'text' },
      { key: 'count', label: 'Questions (1–50; >25 splits into multiple proposals)', placeholder: '5', kind: 'text' },
      { key: 'max_chars', label: 'Input ceiling (chars, default 120000 — long docs auto-slice)', placeholder: '120000', kind: 'text' },
      { key: 'guidance', label: 'Focus (optional)', placeholder: 'e.g. Lecture 01 items only…', kind: 'text' },
    ],
    hasIn: true, hasOut: true,
  },
  'write.comment': {
    cat: 'gate', icon: '💬', title: 'Comment on a task', ty: 'Write · needs approval', tag: 'needs approval',
    desc: 'Files the upstream text as a comment PROPOSAL on one specific, existing task — pick the project, then the task. Same validator and gate as a chat turn, attributed “(via agent)”; approve it in Assistant › Activity.',
    params: [
      { key: 'project_id', label: 'Project', placeholder: '', kind: 'project' },
      { key: 'task_id', label: 'Task (existing)', placeholder: '', kind: 'task' },
    ],
    hasIn: true, hasOut: false,
  },
  'write.task': {
    cat: 'gate', icon: '🗂️', title: 'Propose new task', ty: 'Write · needs approval', tag: 'needs approval',
    desc: 'Proposes CREATING a new task in a project — the title comes from this node, the upstream text becomes its description. Nothing exists until you approve the proposal in Assistant › Activity.',
    params: [
      { key: 'project_id', label: 'Project', placeholder: '', kind: 'project' },
      { key: 'title', label: 'Task title', placeholder: 'e.g. Daily market brief' },
    ],
    hasIn: true, hasOut: false,
  },
};

const PALETTE_GROUPS: { label: string; color: string; types: string[] }[] = [
  { label: 'Triggers', color: CAT_COLOR.amber, types: ['trigger.manual', 'trigger.schedule'] },
  { label: 'Acquire (untrusted)', color: CAT_COLOR.coral, types: ['fetch.http'] },
  { label: 'Inside the walls', color: CAT_COLOR.teal, types: ['file.read', 'llm.transform'] },
  { label: 'Writes (gated)', color: CAT_COLOR.gate, types: ['write.comment', 'write.task', 'quiz.generate'] },
];
// Self-healing: a NODE_DEF missing from the groups above still reaches the
// palette (quiz.generate shipped fully wired but UNREACHABLE — never again).
{
  const placed = new Set(PALETTE_GROUPS.flatMap((g) => g.types));
  const orphans = Object.keys(NODE_DEFS).filter((t) => !placed.has(t));
  if (orphans.length > 0) {
    PALETTE_GROUPS.push({ label: 'More', color: CAT_COLOR.teal, types: orphans });
  }
}

/** Next-run label for a workflow (null when it has no schedule trigger). */
function nextRunLabel(w: OracleWorkflow): string | null {
  const sched = w.definition.nodes.find((n) => n.type === 'trigger.schedule');
  if (!sched) return null;
  return scheduleLabel(sched.params?.every, w.status === 'live', w.last_run_at);
}

const NW = 180; // node width — wire endpoints depend on it
const NH = 64;

function wirePath(from: OracleNode, to: OracleNode): string {
  const x1 = from.x + NW, y1 = from.y + NH / 2;
  const x2 = to.x, y2 = to.y + NH / 2;
  if (x2 - x1 > 26) {
    const dx = Math.max(40, (x2 - x1) * 0.5);
    return `M${x1} ${y1} C${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
  }
  const o = x1 + 26, b = x2 - 26, my = (y1 + y2) / 2;
  return `M${x1} ${y1} L${o} ${y1} L${o} ${my} L${b} ${my} L${b} ${y2} L${x2} ${y2}`;
}

/** The Assistant's Oracle tab: draw an automation as a node graph, save it,
 * run it. Node drag is pointer-based (never HTML5 DnD — broken in WKWebView);
 * wires connect by clicking an output port, then an input port. */
export default function OraclePanel() {
  const [workflows, setWorkflows] = useState<OracleWorkflow[]>([]);
  const [selId, setSelId] = useState<number | null>(null);
  const [notOwner, setNotOwner] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  // The EDITABLE copy of the selected workflow (definition + name), with a
  // dirty flag so “Save” means something.
  const [name, setName] = useState('');
  const [def, setDef] = useState<OracleDefinition>({ nodes: [], wires: [] });
  const [dirty, setDirty] = useState(false);
  const [selNode, setSelNode] = useState<string | null>(null);
  const [pendingWire, setPendingWire] = useState<string | null>(null); // out-port clicked, waiting for an in-port
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [running, setRunning] = useState(false);
  type RunView = { run_id: number; status: 'running' | 'done' | 'partial' | 'failed' | 'aborted'; nodes: Record<string, import('../lib/daemon').OracleRunNodeResult> };
  const [runResult, setRunResult] = useState<RunView | null>(null);
  // Write-target pickers: projects once, tasks per chosen project (cached).
  const [projects, setProjects] = useState<Project[]>([]);
  const [tasksByProject, setTasksByProject] = useState<Map<number, Task[]>>(new Map());
  type FileRow = { key: string; label: string; taskId?: number; taskTitle?: string };
  const [filesByProject, setFilesByProject] = useState<Map<number, FileRow[]>>(new Map());
  // Picker refinement state (one inspector at a time — shared is fine).
  const [fileSearch, setFileSearch] = useState('');
  const [fileTaskFilter, setFileTaskFilter] = useState('all');
  const [quizTopicsByProject, setQuizTopicsByProject] = useState<Map<number, {
    subjects: { id: number; name: string }[];
    topics: { id: number; subject_id: number; name: string; subject_name: string }[];
  }>>(new Map());

  const selected = workflows.find((w) => w.id === selId) ?? null;

  const load = async () => {
    try {
      const r = await listOracleWorkflows();
      setWorkflows(r.workflows);
      return r.workflows;
    } catch (e) {
      if (e instanceof DaemonError && (e.status === 401 || e.status === 403)) setNotOwner(true);
      else setMsg(e instanceof Error ? e.message : String(e));
      return [];
    }
  };
  useEffect(() => { void load(); }, []);
  useEffect(() => {
    // Pickers ask the SAME daemon the workflow runs on (daemonInvoke), never
    // the api.ts transport switch — a local-mode desktop would otherwise fill
    // these dropdowns from the laptop's own DB while the run resolves the ids
    // on the host (the archived-ZZ incident: same number, different project).
    daemonInvoke<Project[]>('get_projects')
      .then((ps) => setProjects(ps.filter((p) => !p.archived)))
      .catch(() => setProjects([]));
  }, []);

  /** Lazy task list for a project the first time a picker needs it. */
  const ensureTasks = (projectId: number) => {
    if (tasksByProject.has(projectId)) return;
    daemonInvoke<Task[]>('get_tasks', { projectId, archived: false })
      .then((ts) => setTasksByProject((m) => new Map(m).set(projectId, ts)))
      .catch(() => setTasksByProject((m) => new Map(m).set(projectId, [])));
  };

  /** Lazy quiz-topic list (same daemon as the run — K2 discipline). Subjects
   * come along too: the ✨ Automatic option is per-SUBJECT and must exist
   * even when a subject has no topics yet (building a bank from scratch). */
  const ensureQuizTopics = (projectId: number) => {
    if (quizTopicsByProject.has(projectId)) return;
    Promise.all([
      daemonInvoke<{ id: number; subject_id: number; name: string; subject_name: string }[]>('get_all_quiz_topics', { projectId }),
      daemonInvoke<{ id: number; name: string }[]>('get_quiz_subjects', { projectId }),
    ])
      .then(([topics, subjects]) => setQuizTopicsByProject((m) => new Map(m).set(projectId, { subjects, topics })))
      .catch(() => setQuizTopicsByProject((m) => new Map(m).set(projectId, { subjects: [], topics: [] })));
  };

  /** Lazy host-file list — BOTH kinds the Files tab shows (project files AND
   * shared task attachments; a pushed local file is an attachment and was
   * invisible here). Composite keys 'p-<id>' / 'a-<id>' carry the kind. */
  const ensureFiles = (projectId: number) => {
    if (filesByProject.has(projectId)) return;
    Promise.all([
      listProjectFiles(projectId).catch(() => [] as ProjectFile[]),
      listProjectAttachments(projectId).catch(() => []),
    ])
      .then(([pf, att]) => {
        const rows = [
          ...pf.map((f) => ({
            key: `p-${f.id}`,
            label: `📄 ${f.rel_path || f.file_name} · ${Math.max(1, Math.round(f.size_bytes / 1024))} KB`,
            sort: f.rel_path || f.file_name,
          })),
          ...att.filter((a) => a.is_shared).map((a) => ({
            key: `a-${a.id}`,
            label: `📎 ${a.file_name} (on “${a.task_title}”) · ${Math.max(1, Math.round(a.storage_size / 1024))} KB`,
            sort: a.file_name,
            taskId: a.task_id,
            taskTitle: a.task_title,
          })),
        ].sort((x, y) => x.sort.localeCompare(y.sort, undefined, { numeric: true }));
        setFilesByProject((m) => new Map(m).set(projectId, rows.map(({ sort: _sort, ...row }) => row)));
      })
      .catch(() => setFilesByProject((m) => new Map(m).set(projectId, [])));
  };

  const openWorkflow = (w: OracleWorkflow) => {
    setSelId(w.id);
    setName(w.name);
    setDef(JSON.parse(JSON.stringify(w.definition)) as OracleDefinition);
    setDirty(false);
    setSelNode(null);
    setPendingWire(null);
    setRunResult(null);
    setMsg(null);
  };

  const newWorkflow = async () => {
    try {
      const start: OracleDefinition = {
        nodes: [{ id: 'n1', type: 'trigger.manual', x: 24, y: 48 }],
        wires: [],
      };
      const { id } = await createOracleWorkflow('New automation', start);
      const ws = await load();
      const w = ws.find((x) => x.id === id);
      if (w) openWorkflow(w);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    }
  };

  const save = async () => {
    if (selId == null) return;
    try {
      await updateOracleWorkflow(selId, { name: name.trim() || 'Untitled', definition: def });
      setDirty(false);
      setMsg('Saved.');
      await load();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    }
  };

  /** LIVE = the host's scheduler may fire this workflow; PAUSED never fires. */
  const toggleLive = async () => {
    if (selected == null) return;
    const next = selected.status === 'live' ? 'paused' : 'live';
    try {
      await updateOracleWorkflow(selected.id, { status: next });
      await load();
      setMsg(next === 'live' ? 'Live — scheduled triggers will fire on the host.' : 'Paused — nothing fires until you go live.');
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    }
  };

  const installTemplate = async (p: OracleTemplate) => {
    try {
      const { id } = await createOracleWorkflow(p.name, JSON.parse(JSON.stringify(p.def)) as OracleDefinition);
      const ws = await load();
      const w = ws.find((x) => x.id === id);
      if (w) openWorkflow(w);
      setMsg('Template installed (paused). Fill the blank parameters, run it once, then go live if you want it scheduled.');
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    }
  };

  const remove = async () => {
    if (selId == null || !await confirmDialog('Delete this automation?')) return;
    try {
      await deleteOracleWorkflow(selId);
      setSelId(null);
      await load();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    }
  };

  const run = async (from?: string, only = false) => {
    if (selId == null || running) return;
    if (dirty) await save();
    setRunning(true);
    setRunResult(null);
    setMsg(null);
    try {
      // Live progress: the runner publishes results-so-far with the current
      // node marked "running" — the canvas walks the graph with the run.
      const r = await runOracleWorkflow(selId, (p) => setRunResult({ ...p, status: 'running' }), from, only);
      setRunResult(r);
      setMsg(
        r.status === 'done'
          ? `Run #${r.run_id} finished${only ? ' (this node only — memory updated)' : from ? ' (partial — upstream frozen)' : ''}.`
          : r.status === 'partial'
          ? `Run #${r.run_id} completed with errors — see the red node${Object.values(r.nodes).filter((n) => n.status === 'failed').length === 1 ? '' : 's'}.`
          : r.status === 'aborted'
          ? `Run #${r.run_id} aborted.`
          : `Run #${r.run_id} failed — see the red node.`
      );
      await load(); // refresh last_run_at
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  };

  // ---- graph editing ----
  const mutate = (fn: (d: OracleDefinition) => void) => {
    setDef((d) => {
      const next = JSON.parse(JSON.stringify(d)) as OracleDefinition;
      fn(next);
      return next;
    });
    setDirty(true);
  };

  const addNode = (type: string) => {
    const id = `n${Date.now().toString(36)}`;
    // Spawn where the user is WORKING: right of the selected node, else the
    // center of the visible viewport — never the far edge of a wide graph.
    let x = 60;
    let y = 60;
    const sel = selNode ? nodeById(selNode) : null;
    const view = viewRef.current;
    if (sel) {
      x = sel.x + NW + 70;
      y = sel.y;
    } else if (view) {
      // Scene sits inside a 24px margin (m-6) — subtract it.
      x = Math.max(0, Math.round(view.scrollLeft + view.clientWidth / 2 - 24 - NW / 2));
      y = Math.max(0, Math.round(view.scrollTop + view.clientHeight / 2 - 24 - NH / 2));
    }
    while (def.nodes.some((n) => Math.abs(n.x - x) < 28 && Math.abs(n.y - y) < 28)) {
      x += 34;
      y += 34;
    }
    mutate((d) => d.nodes.push({ id, type, x, y, params: {} }));
    setSelNode(id);
    setPaletteOpen(false);
  };

  const deleteNode = (id: string) => {
    mutate((d) => {
      d.nodes = d.nodes.filter((n) => n.id !== id);
      d.wires = d.wires.filter((w) => w.from !== id && w.to !== id);
    });
    if (selNode === id) setSelNode(null);
  };

  const setParam = (id: string, key: string, value: string) => {
    mutate((d) => {
      const n = d.nodes.find((x) => x.id === id);
      if (n) n.params = { ...(n.params ?? {}), [key]: value };
    });
  };

  const connect = (from: string, to: string) => {
    if (from === to) return;
    mutate((d) => {
      if (!d.wires.some((w) => w.from === from && w.to === to)) d.wires.push({ from, to });
    });
    setPendingWire(null);
  };

  // ---- node dragging (pointer events; WKWebView-safe) ----
  const dragRef = useRef<{ id: string; dx: number; dy: number } | null>(null);
  const sceneRef = useRef<HTMLDivElement | null>(null);
  // Drag-to-pan (grab the dotted background) + click-suppression after a pan.
  const viewRef = useRef<HTMLDivElement | null>(null);
  const panRef = useRef<{ x: number; y: number; sl: number; st: number; moved: boolean } | null>(null);
  const suppressCanvasClick = useRef(false);
  const onCanvasPointerDown = (e: React.PointerEvent) => {
    const t = e.target as HTMLElement;
    if (t !== e.currentTarget && t !== sceneRef.current) return; // background only
    const v = viewRef.current;
    if (!v) return;
    panRef.current = { x: e.clientX, y: e.clientY, sl: v.scrollLeft, st: v.scrollTop, moved: false };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onCanvasPointerMove = (e: React.PointerEvent) => {
    const p = panRef.current;
    const v = viewRef.current;
    if (!p || !v) return;
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    if (!p.moved && Math.abs(dx) + Math.abs(dy) < 5) return;
    p.moved = true;
    v.scrollLeft = p.sl - dx;
    v.scrollTop = p.st - dy;
  };
  const onCanvasPointerUp = () => {
    if (panRef.current?.moved) suppressCanvasClick.current = true;
    panRef.current = null;
  };

  // Layout autosave: finished node drags persist quietly, so positions never
  // "reset" when the panel remounts or another workflow is opened. Best-effort
  // (a validation refusal surfaces on the next manual ⌘S, not here).
  const nodeMoved = useRef(false);
  const layoutSaveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const saveQuiet = async () => {
    if (selId == null) return;
    try {
      await updateOracleWorkflow(selId, { name: name.trim() || 'Untitled', definition: def });
      setDirty(false);
    } catch {
      /* best-effort */
    }
  };

  const onNodePointerDown = (e: React.PointerEvent, n: OracleNode) => {
    if ((e.target as HTMLElement).dataset.port) return; // ports connect, not drag
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const rect = sceneRef.current?.getBoundingClientRect();
    if (!rect) return;
    dragRef.current = { id: n.id, dx: e.clientX - rect.left - n.x, dy: e.clientY - rect.top - n.y };
    setSelNode(n.id);
  };
  const onNodePointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    const rect = sceneRef.current?.getBoundingClientRect();
    if (!d || !rect) return;
    const x = Math.max(0, Math.round(e.clientX - rect.left - d.dx));
    const y = Math.max(0, Math.round(e.clientY - rect.top - d.dy));
    setDef((prev) => ({
      ...prev,
      nodes: prev.nodes.map((n) => (n.id === d.id ? { ...n, x, y } : n)),
    }));
    setDirty(true);
    nodeMoved.current = true;
  };
  const onNodePointerUp = () => {
    dragRef.current = null;
    if (nodeMoved.current) {
      nodeMoved.current = false;
      clearTimeout(layoutSaveTimer.current);
      layoutSaveTimer.current = setTimeout(() => void saveQuiet(), 800);
    }
  };

  // ---- keybinds (canvas-scoped; never steal keys from a form field) ----
  useEffect(() => {
    if (selected == null) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) {
        // ⌘S / ⌘↩ still work while typing — they're intents, not edits.
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') { e.preventDefault(); if (dirty) void save(); }
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); void run(); }
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') { e.preventDefault(); if (dirty) void save(); return; }
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); void run(e.shiftKey && selNode ? selNode : undefined); return; }
      if (e.key === 'Escape') {
        if (pendingWire) setPendingWire(null);
        else if (paletteOpen) setPaletteOpen(false);
        else setSelNode(null);
        return;
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && selNode) {
        e.preventDefault();
        deleteNode(selNode);
        return;
      }
      if (e.key === 'a' && !e.metaKey && !e.ctrlKey) { setPaletteOpen((v) => !v); return; }
      if (e.key === 'e' && !e.metaKey && !e.ctrlKey && selNode) { void run(selNode, true); return; }
      if (selNode && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
        e.preventDefault();
        const step = e.shiftKey ? 50 : 10;
        const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
        const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
        mutate((d) => {
          const n = d.nodes.find((x) => x.id === selNode);
          if (n) { n.x = Math.max(0, n.x + dx); n.y = Math.max(0, n.y + dy); }
        });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const sceneSize = useMemo(() => {
    // Generous slack beyond the content (and a big floor): the canvas should
    // feel like a drafting table, not a box that hugs the graph.
    const w = Math.max(2000, ...def.nodes.map((n) => n.x + NW + 700));
    const h = Math.max(1200, ...def.nodes.map((n) => n.y + NH + 500));
    return { w, h };
  }, [def.nodes]);

  // Pickers must not serve stale lists: a file uploaded (or quiz topic
  // created) after the cache filled would never appear. Selecting a node
  // invalidates its project's cached lists — the render refetches fresh.
  useEffect(() => {
    if (!selNode) return;
    const n = def.nodes.find((x) => x.id === selNode);
    const pid = Number(n?.params?.project_id ?? '');
    if (!pid) return;
    setFilesByProject((m) => { if (!m.has(pid)) return m; const next = new Map(m); next.delete(pid); return next; });
    setTasksByProject((m) => { if (!m.has(pid)) return m; const next = new Map(m); next.delete(pid); return next; });
    setQuizTopicsByProject((m) => { if (!m.has(pid)) return m; const next = new Map(m); next.delete(pid); return next; });
    setFileSearch('');
    setFileTaskFilter('all');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selNode]);

  const nodeById = (id: string) => def.nodes.find((n) => n.id === id);
  const selectedNode = selNode ? nodeById(selNode) : null;
  const selectedDef = selectedNode ? NODE_DEFS[selectedNode.type] : null;
  const nodeRun = (id: string) => runResult?.nodes?.[id];

  if (notOwner) {
    return (
      <div className="h-full flex items-center justify-center">
        <p className="text-sm text-subtext-0">Automations are built on the host. Ask the owner, or open Ganban on the host machine.</p>
      </div>
    );
  }

  return (
    <div className="h-full flex bg-mantle text-text min-h-0 overflow-x-clip">
      {/* LEFT: automations list */}
      <div className={`${ASSISTANT_TREE_W} shrink-0 border-r border-gilt-b bg-crust flex flex-col min-h-0`}>
        <div className="px-3 py-1.5 border-b border-gilt-b flex items-center justify-between">
          <span className="g-deco text-[11px] font-semibold text-gold">Automations</span>
          <button onClick={() => void load()} className="g-iconbtn !w-8 !h-8" title="Refresh">↻</button>
        </div>
        <div className="p-2">
          <button
            onClick={() => void newWorkflow()}
            className="g-btn g-btn-gilt g-btn-sm w-full"
          >
            ＋ New automation
          </button>
        </div>
        {/* Upcoming: every LIVE scheduled automation, with its honest next-run. */}
        {(() => {
          const upcoming = workflows
            .map((w) => ({ w, label: nextRunLabel(w) }))
            .filter((x) => x.w.status === 'live' && x.label != null);
          return upcoming.length > 0 ? (
            <div className="mx-2 mb-1.5 px-2.5 py-2 rounded border border-success/30 bg-success/5">
              <div className="g-deco text-[10px] font-semibold text-success mb-1">Upcoming</div>
              {upcoming.map(({ w, label }) => (
                <button key={w.id} onClick={() => openWorkflow(w)} className="w-full text-left flex items-center gap-1.5 min-h-8 text-[11px] hover:text-text text-[color:var(--g-fg2)]">
                  <span className="truncate">{w.name}</span>
                  <span className="ml-auto shrink-0 text-success">{label}</span>
                </button>
              ))}
            </div>
          ) : null;
        })()}
        <div className="flex-1 overflow-y-auto px-2 pb-2 space-y-1.5">
          {workflows.length === 0 && (
            <p className="px-2 py-2 text-xs text-subtext-0 italic">
              Nothing yet. An automation is a small graph: fetch something, run one model step over it, and file the result
              through the approval gate. Start from a template below.
            </p>
          )}
          {workflows.map((w) => {
            const sched = nextRunLabel(w);
            return (
            <button
              key={w.id}
              onClick={() => openWorkflow(w)}
              aria-current={selId === w.id ? 'true' : undefined}
              className={`w-full text-left px-3 py-2.5 rounded ${
                selId === w.id ? 'g-sel' : 'hover:bg-surface-0'
              }`}
            >
              <div className="flex items-center gap-2">
                <span className={`w-2 h-2 rounded-full ${w.status === 'live' ? 'bg-success' : 'bg-overlay-0'}`} />
                <span className="text-sm font-medium truncate">{w.name}</span>
              </div>
              <div className="text-[11px] text-subtext-0 mt-0.5">
                {w.definition.nodes.length} node{w.definition.nodes.length === 1 ? '' : 's'}
                {w.last_run_at ? ` · ran ${w.last_run_at.slice(0, 16).replace('T', ' ')}` : ' · never run'}
              </div>
              {sched && <div className={`text-[11px] mt-0.5 ${w.status === 'live' ? 'text-success' : 'text-subtext-0'}`}>⏱ {sched}</div>}
            </button>
            );
          })}
          {/* Template library — installable starting points, one blank away
              from runnable so filling them IS the tutorial. */}
          {(() => {
            const uninstalled = ORACLE_TEMPLATES.filter((p) => !workflows.some((w) => w.name === p.name));
            if (uninstalled.length === 0) return null;
            const cats = [...new Set(uninstalled.map((p) => p.category))];
            return (
              <div className="pt-2">
                <div className="g-h2 !text-[11px] !mb-2 !mt-2">Template library</div>
                {cats.map((c) => (
                  <div key={c}>
                    <div className="g-deco px-1 pt-1 pb-1 text-[10px] font-semibold tracking-[0.2em] text-[color:var(--g-mut)]">{c}</div>
                    {uninstalled.filter((p) => p.category === c).map((p) => (
                      <button
                        key={p.name}
                        onClick={() => void installTemplate(p)}
                        className="g-plain g-glint block w-full text-left px-3 py-2 mb-1.5 border-dashed hover:!border-gilt-a"
                      >
                        <div className="text-xs font-medium text-text">＋ {p.name}</div>
                        <div className="text-[11px] text-subtext-0 mt-0.5">{p.blurb}</div>
                      </button>
                    ))}
                  </div>
                ))}
              </div>
            );
          })()}
        </div>
      </div>

      {/* CENTER: canvas */}
      <div className="flex-1 min-w-0 flex flex-col min-h-0">
        {selected == null ? (
          <div className="flex-1 flex items-center justify-center p-8">
            <div className="max-w-md text-center space-y-2">
              <div className="text-3xl">🔮</div>
              <p className="text-sm text-subtext-0">
                Pick an automation, or create one. Colors are the trust legend: <span style={{ color: CAT_COLOR.amber }}>triggers</span>,{' '}
                <span style={{ color: CAT_COLOR.coral }}>untrusted content</span>, <span style={{ color: CAT_COLOR.teal }}>inside the walls</span>,{' '}
                <span style={{ color: CAT_COLOR.gate }}>gated writes</span>. Writes never apply on their own — they file proposals.
              </p>
            </div>
          </div>
        ) : (
          <>
            {/* header */}
            <div className="min-h-12 shrink-0 flex flex-wrap items-center gap-2 px-4 py-1.5 border-b border-gilt-b bg-base min-w-0">
              <input
                value={name}
                onChange={(e) => { setName(e.target.value); setDirty(true); }}
                className="min-h-9 px-2 text-[15px] font-semibold bg-transparent border border-transparent hover:border-surface-1 focus:border-gold focus:bg-mantle rounded focus:outline-none min-w-0 flex-1 max-w-xs"
              />
              <span className="text-[11px] text-subtext-0">
                {running ? 'running…' : dirty ? 'unsaved changes' : 'saved'}
              </span>
              <div className="ml-auto flex items-center gap-1.5">
                <div className="relative">
                  <button
                    onClick={() => setPaletteOpen((v) => !v)}
                    className="g-btn g-btn-ghost g-btn-sm"
                  >
                    ＋ Add node
                  </button>
                  {paletteOpen && (
                    <div className="absolute right-0 top-full mt-1 w-64 bg-base border border-gilt-a rounded shadow-2xl z-20 p-2 space-y-1 max-h-80 overflow-y-auto">
                      {PALETTE_GROUPS.map((g) => (
                        <div key={g.label}>
                          <div className="g-deco flex items-center gap-1.5 px-1 pt-1 pb-0.5 text-[10px] font-semibold tracking-[0.2em] text-[color:var(--g-mut)]">
                            <span className="w-2 h-2 rounded-full" style={{ background: g.color }} />
                            {g.label}
                          </div>
                          {g.types.map((t) => (
                            <button
                              key={t}
                              onClick={() => addNode(t)}
                              className="w-full text-left min-h-9 px-2 py-1.5 rounded hover:bg-surface-0 flex items-center gap-2"
                            >
                              <span
                                className="w-6 h-6 rounded-lg grid place-items-center text-sm shrink-0"
                                style={{ background: tint(CAT_COLOR[NODE_DEFS[t].cat], 13), color: CAT_COLOR[NODE_DEFS[t].cat] }}
                              >
                                {NODE_DEFS[t].icon}
                              </span>
                              <span className="min-w-0">
                                <span className="block text-xs text-text">{NODE_DEFS[t].title}</span>
                                <span className="block text-[10px] text-subtext-0 truncate">{NODE_DEFS[t].ty}</span>
                              </span>
                            </button>
                          ))}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                <button
                  onClick={() => void save()}
                  disabled={!dirty}
                  className="g-btn g-btn-ghost g-btn-sm"
                >
                  Save
                </button>
                <button onClick={remove} className="g-btn g-btn-danger g-btn-sm">
                  Delete
                </button>
                <button
                  onClick={() => void toggleLive()}
                  className={`g-btn g-btn-sm g-btn-ghost ${
                    selected.status === 'live' ? '!text-success !shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--color-success)_50%,transparent)]' : ''
                  }`}
                  title={selected.status === 'live' ? 'Live — schedule triggers fire on the host. Click to pause.' : 'Paused — nothing fires. Click to go live.'}
                >
                  {selected.status === 'live' ? '● live' : '⏸ paused'}
                </button>
                {running ? (
                  <button
                    onClick={() => { if (selId != null) void cancelOracleRun(selId); }}
                    title="Abort this run — remaining nodes are skipped, the in-flight model call is cut"
                    className="g-btn g-btn-danger g-btn-sm"
                  >
                    ■ Stop
                  </button>
                ) : (
                  <button
                    onClick={() => void run()}
                    className="g-btn g-btn-pri g-btn-sm"
                  >
                    ▶ Run now
                  </button>
                )}
              </div>
            </div>

            {/* canvas */}
            <div
              ref={viewRef}
              className="flex-1 min-h-0 overflow-auto relative"
              style={{
                background: 'var(--color-surface-0)',
                backgroundImage: 'radial-gradient(circle, color-mix(in srgb, var(--color-text) 7%, transparent) 1px, transparent 1.4px)',
                backgroundSize: '22px 22px',
                cursor: panRef.current?.moved ? 'grabbing' : undefined,
              }}
              onPointerDown={onCanvasPointerDown}
              onPointerMove={onCanvasPointerMove}
              onPointerUp={onCanvasPointerUp}
              onClick={() => {
                if (suppressCanvasClick.current) { suppressCanvasClick.current = false; return; }
                setPendingWire(null);
                setPaletteOpen(false);
              }}
            >
              <div ref={sceneRef} className="relative m-6" style={{ width: sceneSize.w, height: sceneSize.h }}>
                <svg className="absolute inset-0 overflow-visible pointer-events-none" width={sceneSize.w} height={sceneSize.h}>
                  {def.wires.map((w, i) => {
                    const from = nodeById(w.from);
                    const to = nodeById(w.to);
                    if (!from || !to) return null;
                    const col = CAT_COLOR[NODE_DEFS[from.type]?.cat ?? 'teal'];
                    return (
                      <g key={i}>
                        <path d={wirePath(from, to)} fill="none" stroke={col} strokeWidth={2.2} opacity={0.9} />
                        {/* invisible fat hit-path: click a wire to cut it */}
                        <path
                          d={wirePath(from, to)}
                          fill="none"
                          stroke="transparent"
                          strokeWidth={12}
                          style={{ pointerEvents: 'stroke', cursor: 'pointer' }}
                          onClick={(e) => {
                            e.stopPropagation();
                            mutate((d) => { d.wires = d.wires.filter((x) => !(x.from === w.from && x.to === w.to)); });
                          }}
                        >
                          <title>Click to remove this wire</title>
                        </path>
                      </g>
                    );
                  })}
                </svg>

                {def.nodes.map((n) => {
                  const nd = NODE_DEFS[n.type];
                  if (!nd) return null;
                  const col = CAT_COLOR[nd.cat];
                  const rr = nodeRun(n.id);
                  return (
                    <div
                      key={n.id}
                      onPointerDown={(e) => onNodePointerDown(e, n)}
                      onPointerMove={onNodePointerMove}
                      onPointerUp={onNodePointerUp}
                      onClick={(e) => { e.stopPropagation(); setSelNode(n.id); }}
                      className="absolute rounded border bg-base px-3 py-2 cursor-pointer select-none touch-none shadow-lg"
                      style={{
                        left: n.x, top: n.y, width: NW, height: NH,
                        borderColor: selNode === n.id ? col : tint(col, 33),
                        outline: selNode === n.id ? `2px solid ${tint(col, 27)}` : undefined,
                      }}
                    >
                      {nd.tag && (
                        <span
                          className="absolute -top-2 right-2 text-[8px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded"
                          style={{ background: tint(col, 15), color: col }}
                        >
                          {nd.tag}
                        </span>
                      )}
                      {rr && (
                        <span
                          className={`absolute -top-2 left-2 text-[8px] font-bold uppercase px-1.5 py-0.5 rounded ${rr.status === 'running' ? 'animate-pulse' : ''}`}
                          style={{
                            background: tint(runCol(rr.status), rr.status === 'running' ? 22 : 18),
                            color: runCol(rr.status),
                          }}
                        >
                          {rr.status === 'running' ? '● running' : rr.status === 'frozen' ? '❄ frozen' : rr.status}
                        </span>
                      )}
                      <div className="flex items-center gap-2">
                        <span className="w-6 h-6 rounded-lg grid place-items-center text-sm shrink-0" style={{ background: tint(col, 13), color: col }}>
                          {nd.icon}
                        </span>
                        <span className="text-xs font-semibold truncate" style={{ color: col }}>{nd.title}</span>
                      </div>
                      <div className="text-[10px] text-subtext-0 truncate mt-1">
                        {nd.params.map((p) => n.params?.[p.key]).filter(Boolean).join(' · ') || nd.ty}
                      </div>
                      {/* ports */}
                      {nd.hasIn && (
                        <span
                          data-port="in"
                          onClick={(e) => {
                            e.stopPropagation();
                            if (pendingWire) connect(pendingWire, n.id);
                          }}
                          title={pendingWire ? 'Click to connect here' : 'Input'}
                          className="absolute w-3 h-3 rounded-full border-2 bg-mantle"
                          style={{
                            left: -6, top: NH / 2 - 6, borderColor: col,
                            boxShadow: pendingWire ? `0 0 0 4px ${tint(col, 20)}` : undefined,
                            cursor: pendingWire ? 'crosshair' : 'default',
                          }}
                        />
                      )}
                      {nd.hasOut && (
                        <span
                          data-port="out"
                          onClick={(e) => {
                            e.stopPropagation();
                            setPendingWire(pendingWire === n.id ? null : n.id);
                          }}
                          title="Click, then click a target's input port to wire"
                          className="absolute w-3 h-3 rounded-full border-2 bg-mantle cursor-crosshair"
                          style={{
                            right: -6, top: NH / 2 - 6, borderColor: col,
                            boxShadow: pendingWire === n.id ? `0 0 0 4px ${tint(col, 33)}` : undefined,
                          }}
                        />
                      )}
                    </div>
                  );
                })}

                {/* legend */}
                <div className="absolute left-0 bottom-0 flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-[color:var(--g-fg2)] bg-base/90 border border-gilt-a rounded px-3 py-1.5">
                  {PALETTE_GROUPS.map((g) => (
                    <span key={g.label} className="flex items-center gap-1.5">
                      <span className="w-2 h-2 rounded-full" style={{ background: g.color }} />
                      {g.label.toLowerCase()}
                    </span>
                  ))}
                  <span>· click an output port, then an input port, to wire</span>
                </div>
              </div>
            </div>
            {msg && <div className="px-4 py-1.5 text-xs text-[color:var(--g-fg2)] border-t border-gilt-b bg-base shrink-0">{msg}</div>}
          </>
        )}
      </div>

      {/* RIGHT: inspector */}
      {selected != null && (
        <div className="w-72 xl:w-80 shrink-0 border-l border-gilt-b bg-base overflow-y-auto overflow-x-hidden p-4 space-y-3">
          {selectedNode && selectedDef ? (
            <>
              <div className="flex items-center gap-2.5">
                <span
                  className="w-9 h-9 rounded-lg grid place-items-center text-lg shrink-0"
                  style={{ background: tint(CAT_COLOR[selectedDef.cat], 13), color: CAT_COLOR[selectedDef.cat] }}
                >
                  {selectedDef.icon}
                </span>
                <div className="min-w-0">
                  <div className="text-[15px] font-semibold">{selectedDef.title}</div>
                  <div className="text-[11px] text-subtext-0">{selectedDef.ty}</div>
                </div>
              </div>
              <p className="text-xs text-subtext-0 leading-relaxed">{selectedDef.desc}</p>
              {selectedDef.params.length > 0 && (
                <div className="space-y-2">
                  <div className="g-deco text-[10px] font-semibold text-gold">Parameters</div>
                  {selectedDef.params.map((p) => {
                    const val = selectedNode.params?.[p.key] ?? '';
                    if (p.kind === 'project') {
                      return (
                        <div key={p.key}>
                          <label className="g-flbl">{p.label}</label>
                          <select
                            value={val}
                            onChange={(e) => {
                              setParam(selectedNode.id, p.key, e.target.value);
                              // A new project invalidates a previously chosen task/file.
                              if (selectedNode.params?.task_id) setParam(selectedNode.id, 'task_id', '');
                              if (selectedNode.params?.file_id) setParam(selectedNode.id, 'file_id', '');
                              if (e.target.value) { ensureTasks(Number(e.target.value)); ensureFiles(Number(e.target.value)); }
                            }}
                            className="g-field g-field-sm w-full"
                          >
                            <option value="">Pick a project…</option>
                            {projects.map((pr) => (
                              <option key={pr.id} value={pr.id}>{pr.name}</option>
                            ))}
                          </select>
                        </div>
                      );
                    }
                    if (p.kind === 'task') {
                      const projectId = Number(selectedNode.params?.project_id ?? '');
                      const tasks = projectId ? tasksByProject.get(projectId) : undefined;
                      if (projectId && !tasks) ensureTasks(projectId);
                      return (
                        <div key={p.key}>
                          <label className="g-flbl">{p.label}</label>
                          <select
                            value={val}
                            onChange={(e) => setParam(selectedNode.id, p.key, e.target.value)}
                            disabled={!projectId}
                            className="g-field g-field-sm w-full"
                          >
                            <option value="">{projectId ? (tasks ? 'Pick a task…' : 'Loading tasks…') : 'Pick a project first'}</option>
                            {(tasks ?? []).map((t) => (
                              <option key={t.id} value={t.id}>#{t.id} · {t.title}</option>
                            ))}
                          </select>
                        </div>
                      );
                    }
                    if (p.kind === 'quiztopic') {
                      const projectId = Number(selectedNode.params?.project_id ?? '');
                      const qts = projectId ? quizTopicsByProject.get(projectId) : undefined;
                      if (projectId && !qts) ensureQuizTopics(projectId);
                      return (
                        <div key={p.key}>
                          <label className="g-flbl">{p.label}</label>
                          <select
                            value={val}
                            onChange={(e) => setParam(selectedNode.id, p.key, e.target.value)}
                            disabled={!projectId}
                            className="g-field g-field-sm w-full"
                          >
                            <option value="">{projectId ? (qts ? (qts.subjects.length ? 'Pick a topic…' : 'No quiz subjects in this project') : 'Loading topics…') : 'Pick a project first'}</option>
                            {(qts?.subjects ?? []).map((sub) => (
                              <optgroup key={sub.id} label={sub.name}>
                                {/* auto-<subjectId>: the model files each question
                                    under a topic it names (created on demand). */}
                                <option value={`auto-${sub.id}`}>✨ Automatic — model picks each question's topic</option>
                                {(qts?.topics ?? []).filter((t) => t.subject_id === sub.id).map((t) => (
                                  <option key={t.id} value={t.id}>{t.name}</option>
                                ))}
                              </optgroup>
                            ))}
                          </select>
                        </div>
                      );
                    }
                    if (p.kind === 'file') {
                      const projectId = Number(selectedNode.params?.project_id ?? '');
                      const files = projectId ? filesByProject.get(projectId) : undefined;
                      if (projectId && !files) ensureFiles(projectId);
                      // Composite select value: 'p-<id>' project file, 'a-<id>'
                      // shared attachment — stored as file_id + file_kind.
                      const kind = selectedNode.params?.file_kind === 'attachment' ? 'a' : 'p';
                      const composite = val ? `${kind}-${val}` : '';
                      // Refinements: text search + narrow to one task's
                      // attachments (or project files only).
                      const taskOptions = [...new Map((files ?? []).filter((f) => f.taskId != null).map((f) => [f.taskId, f.taskTitle])).entries()];
                      const q = fileSearch.trim().toLowerCase();
                      const shown = (files ?? []).filter((f) => {
                        if (fileTaskFilter === 'project' && f.taskId != null) return false;
                        if (fileTaskFilter.startsWith('t-') && String(f.taskId ?? '') !== fileTaskFilter.slice(2)) return false;
                        if (q && !f.label.toLowerCase().includes(q)) return false;
                        return true;
                      });
                      return (
                        <div key={p.key}>
                          <label className="g-flbl">{p.label}</label>
                          <div className="flex gap-1 mb-1">
                            <input
                              value={fileSearch}
                              onChange={(e) => setFileSearch(e.target.value)}
                              placeholder="Search files…"
                              disabled={!projectId}
                              className="g-field g-field-sm flex-1 min-w-0"
                            />
                            <select
                              value={fileTaskFilter}
                              onChange={(e) => setFileTaskFilter(e.target.value)}
                              disabled={!projectId}
                              title="Narrow by task"
                              className="g-field g-field-sm !w-24"
                            >
                              <option value="all">All</option>
                              <option value="project">📄 Project</option>
                              {taskOptions.map(([id, title]) => (
                                <option key={id} value={`t-${id}`}>📎 {title}</option>
                              ))}
                            </select>
                          </div>
                          <select
                            value={composite}
                            onChange={(e) => {
                              const v = e.target.value;
                              if (!v) {
                                setParam(selectedNode.id, p.key, '');
                                setParam(selectedNode.id, 'file_kind', '');
                                return;
                              }
                              const [k, id] = [v.slice(0, 1), v.slice(2)];
                              setParam(selectedNode.id, p.key, id);
                              setParam(selectedNode.id, 'file_kind', k === 'a' ? 'attachment' : 'project');
                            }}
                            disabled={!projectId}
                            className="g-field g-field-sm w-full"
                          >
                            <option value="">{projectId ? (files ? (files.length === 0 ? 'No host files in this project' : shown.length === 0 ? 'Nothing matches the filters' : `Pick a file… (${shown.length})`) : 'Loading files…') : 'Pick a project first'}</option>
                            {shown.map((f) => (
                              <option key={f.key} value={f.key}>{f.label}</option>
                            ))}
                            {/* keep the current pick visible even when filtered out */}
                            {composite && !shown.some((f) => f.key === composite) && (files ?? []).filter((f) => f.key === composite).map((f) => (
                              <option key={f.key} value={f.key}>{f.label}</option>
                            ))}
                          </select>
                        </div>
                      );
                    }
                    return (
                      <div key={p.key}>
                        <label className="g-flbl">{p.label}</label>
                        {p.kind === 'textarea' ? (
                          <textarea
                            value={val}
                            onChange={(e) => setParam(selectedNode.id, p.key, e.target.value)}
                            placeholder={p.placeholder}
                            rows={4}
                            className="g-field g-field-sm w-full resize-y"
                          />
                        ) : (
                          <input
                            value={val}
                            onChange={(e) => setParam(selectedNode.id, p.key, e.target.value)}
                            placeholder={p.placeholder}
                            className="g-field g-field-sm w-full"
                          />
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
              {selectedDef.note && <p className="text-[11px] text-subtext-0 italic">{selectedDef.note}</p>}
              {(() => {
                const rr = nodeRun(selectedNode.id);
                return rr ? (
                  <div className="space-y-1">
                    <div className="g-deco text-[10px] font-semibold text-gold">Last run</div>
                    <div
                      className="text-xs font-mono rounded border p-2 whitespace-pre-wrap break-words max-h-56 overflow-y-auto"
                      style={{
                        borderColor: rr.status === 'failed' ? tint('var(--color-error)', 40) : 'var(--color-surface-0)',
                        background: 'var(--color-mantle)',
                      }}
                    >
                      {rr.preview || '(empty)'}
                    </div>
                    {rr.note && <div className="text-[11px] text-primary break-words">{rr.note}</div>}
                  </div>
                ) : null;
              })()}
              <button
                onClick={() => void run(selectedNode.id, true)}
                disabled={running}
                className="g-btn g-btn-sm w-full !bg-transparent hover:!bg-surface-0"
                style={{ boxShadow: `inset 0 0 0 1px ${tint('var(--g-teal)', 45)}`, color: 'var(--g-teal)' }}
                title="Notebook cell: execute JUST this node. Its inputs replay frozen from the last run; its output is stored; downstream nodes keep their memory untouched."
              >
                ▶ Execute step (this node only)
              </button>
              <button
                onClick={() => void run(selectedNode.id)}
                disabled={running}
                className="g-btn g-btn-sm w-full !bg-transparent hover:!bg-surface-0"
                style={{ boxShadow: `inset 0 0 0 1px ${tint('var(--color-info)', 45)}`, color: 'var(--color-info)' }}
                title="Re-run this node and everything after it. Everything before it is FROZEN to the last run's outputs — no re-fetching while you debug the tail."
              >
                ▶ Run from this node (❄ freeze upstream)
              </button>
              <button
                onClick={() => deleteNode(selectedNode.id)}
                className="g-btn g-btn-danger g-btn-sm w-full"
              >
                Remove node
              </button>
            </>
          ) : (
            <div className="text-xs text-subtext-0 space-y-2 leading-relaxed">
              <p className="g-deco text-[10px] font-semibold text-gold">How this works</p>
              <p>Select a node to configure it. Drag nodes to arrange; click an output port, then an input port, to wire them; click a wire to cut it.</p>
              <p>
                Data flows left to right. Content from <span style={{ color: CAT_COLOR.coral }}>coral</span> nodes is untrusted — the{' '}
                <span style={{ color: CAT_COLOR.teal }}>model step</span> may read it but holds no tools, and every{' '}
                <span style={{ color: CAT_COLOR.gate }}>write</span> lands as a proposal for you to approve in Activity.
              </p>
              <p>Each model step is ledgered like any other run on this host.</p>
              <p>
                <span className="text-text">Scheduling:</span> a Schedule trigger fires on the host's clock only while the
                automation is <span className="text-success">● live</span> (header toggle). Cadences: “30 min”, “2 hours”,
                “1 day”, or “07:00” daily. “Upcoming” at the top-left shows what will fire and when.
              </p>
              <p>
                <span className="text-text">Debugging:</span> run a node with <kbd className="font-mono">E</kbd> to test it
                alone (its inputs replay frozen — no re-fetching), and check its “Last run” output here in the inspector.
              </p>
              <div className="pt-2 border-t border-gilt-b">
                <p className="g-deco text-[10px] font-semibold text-gold mb-1">Keys</p>
                <div className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-[11px]">
                  <kbd className="font-mono text-subtext-1">A</kbd><span>add node</span>
                  <kbd className="font-mono text-subtext-1">⌫</kbd><span>remove selected node</span>
                  <kbd className="font-mono text-subtext-1">Esc</kbd><span>cancel wire / deselect</span>
                  <kbd className="font-mono text-subtext-1">←↑↓→</kbd><span>nudge node (⇧ = coarse)</span>
                  <kbd className="font-mono text-subtext-1">⌘S</kbd><span>save</span>
                  <kbd className="font-mono text-subtext-1">⌘↩</kbd><span>run now</span>
                  <kbd className="font-mono text-subtext-1">⌘⇧↩</kbd><span>run from selected node (freeze upstream)</span>
                  <kbd className="font-mono text-subtext-1">E</kbd><span>execute selected node only (notebook cell)</span>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
