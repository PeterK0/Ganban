import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { updateTask as updateTaskApi, getTimeEntries, getTaskTotalTime, getAreas, getFileAttachments, createFileAttachment, deleteFileAttachment, updateFileAttachment, getTaskEvents, getProjectEvents, linkEventToTask, unlinkEventFromTask, shareFileAttachment, unshareFileAttachment, getProjectStorage, setProjectQuota, attachPastedImage, getAssignees, assignTask, unassignTask, assignContact, unassignContact, getProjectMemberOverview } from '../lib/api';
import AssigneePicker from './AssigneePicker';
import { openTaskWindow } from '../lib/windows';
import { useAppStore } from '../store/appStore';
import type { Task, UpdateTaskInput, TimeEntry, Area, FileAttachment, Event, TaskAssignee, ProjectMemberOverview } from '../types';
import { assigneeKey } from '../types';
import TimeEntriesList from './TimeEntriesList';
import TaskDescriptionModal from './TaskDescriptionModal';
import CommentList from './CommentList';
import MarkdownPreview from './MarkdownPreview';
import MultiSelectDropdown from './MultiSelectDropdown';
import { open } from '@tauri-apps/plugin-dialog';
import { openPath } from '@tauri-apps/plugin-opener';
import { isTauri, hasDaemon, restoreSharedFile, runLocalAgentTask, submitProposal, downloadSharedFile } from '../lib/daemon';
import { hasFilePaths, revealLocalPath, type RevealResult } from '../lib/shell';
import TaskVisibilityField from './TaskVisibilityField';
import TaskVisibilityBadge, { isRestricted } from './TaskVisibilityBadge';
import { Modal } from './gilt';
import TaskUploadArea from './TaskUploadArea';
import TaskShareLinks from './ShareLinks';
import FileBrowser, { type FileEntry } from './files/FileBrowser';
import type { TaskUploadHandle } from './TaskUploadArea';
import { useProjectRole } from '../lib/projectRole';
import { onBeforeRestart } from '../lib/restartFlush';
import {
  applyForm, forgetPending, formFromTask, formsEqual, formToUpdate, freshest, isFormDirty, isFormSavable,
  beginSave, rememberPending, rememberSaved, type TaskForm,
} from '../lib/taskForm';

/** Strip markdown control chars from a filename so it can sit safely inside a
 * `[text](/files/N)` link without breaking the link syntax. */
function safeLinkText(name: string): string {
  return name.replace(/[\[\]]/g, '').trim() || 'file';
}

/** One pickable row in the `/file` picker. Image attachments get two options
 * (link + embed); everything else gets one (link). Built pure so the textarea's
 * keyboard handler and the picker render the same list. */
type FileOption = { att: FileAttachment; mode: 'link' | 'embed' };
function buildFileOptions(attachments: FileAttachment[], query: string): FileOption[] {
  const q = query.trim().toLowerCase();
  const rows = q ? attachments.filter((a) => a.file_name.toLowerCase().includes(q)) : attachments;
  // Shared first: a /files/<id> ref only resolves for shared attachments, so the
  // options that work without a prompt sit at the top.
  const sorted = [...rows].sort((a, b) => Number(b.is_shared) - Number(a.is_shared));
  const opts: FileOption[] = [];
  for (const att of sorted) {
    opts.push({ att, mode: 'link' });
    if ((att.file_type || '').startsWith('image/')) {
      opts.push({ att, mode: 'embed' });
    }
  }
  return opts;
}

/** Client-side preference for the local-file-link warning. Default ON (warn);
 * the "Don't show again" checkbox in the dialog turns it OFF. Mirror exists in
 * Settings → Data & Storage. */
const WARN_LOCAL_LINK_KEY = 'ganban:warn-local-file-link';
function shouldWarnLocalFileLink(): boolean {
  return localStorage.getItem(WARN_LOCAL_LINK_KEY) !== '0';
}
function setWarnLocalFileLink(warn: boolean): void {
  localStorage.setItem(WARN_LOCAL_LINK_KEY, warn ? '1' : '0');
}

const toLocalDateString = (d: Date) => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

const USE_EVENT_DEADLINE_KEY = 'taskEditor.useEventDeadline';
/** "More details" open or closed: a per-device cosmetic preference (TAB_SPEC). */
const MORE_OPEN_KEY = 'ganban.task.moreOpen';
const storedMoreOpen = (): boolean => {
  try {
    return localStorage.getItem(MORE_OPEN_KEY) === '1';
  } catch {
    return false;
  }
};
/** Just created and never edited: it opens with "More details" closed. */
const isFreshTask = (t: Task): boolean =>
  t.created_at === t.updated_at && Math.abs(Date.now() - new Date(t.created_at).getTime()) < 5 * 60_000;

interface TaskEditorProps {
  task: Task | null;
  onSave: (task: Task) => void;
  /** Delete the task. May resolve to `false` when the delete failed. */
  onDelete: () => void | Promise<boolean | void>;
  width?: number;
  /** Fill the parent (used inside DetailPane) instead of a fixed-width rail. */
  fill?: boolean;
  /** Full-PAGE layout (the Tasks tab): comments under the description and Save
   * beside the fields instead of in a footer. Whether the fields sit beside the
   * description is measured from the editor's own width in both modes. */
  page?: boolean;
  /** Open a linked event in a navigable detail pane (click-through). */
  onOpenEvent?: (event: Event) => void;
  /** Set to the editor's save, for a parent that hides the editor without
   * unmounting it (a collapsible pane's ✕): call it before hiding. */
  flushOnClose?: { current: (() => Promise<void>) | null };
}

export default function TaskEditor({ task, onSave, onDelete, width = 384, fill = false, page = false, onOpenEvent, flushOnClose }: TaskEditorProps) {
  const { setTaskTime, activeTask, setActiveTask } = useAppStore();
  const isActive = !!task && activeTask?.id === task.id;

  // All hooks must be called unconditionally before any early returns
  // The form opens on the newest copy of the task this window knows (see the
  // seeding effect), so the first render already matches what a save compares
  // against.
  const [seedTask] = useState(() => (task ? freshest(task) : null));
  const seedForm = seedTask ? formFromTask(seedTask) : null;
  const [title, setTitle] = useState(seedForm?.title ?? '');
  const [description, setDescription] = useState(seedForm?.description ?? '');
  const [status, setStatus] = useState<Task['status']>((seedForm?.status ?? 'To Do') as Task['status']);
  const [priority, setPriority] = useState<Task['priority']>((seedForm?.priority ?? 'Medium') as Task['priority']);
  const [prefix, setPrefix] = useState(seedForm?.prefix ?? '');
  const [cost, setCost] = useState(seedForm?.cost ?? '');
  const [currency, setCurrency] = useState(seedForm?.currency ?? '');
  const [deadline, setDeadline] = useState(seedForm?.deadline ?? '');
  const [areaId, setAreaId] = useState<number | undefined>(seedForm?.areaId);
  // The task the form state belongs to. It changes with the form (the seeding
  // effect), not with the prop: in the render where the prop moves to another
  // task, the form still holds the previous task's values.
  const [formTaskId, setFormTaskId] = useState<number | null>(seedTask?.id ?? null);
  const [pinned, setPinned] = useState(seedTask?.pinned || false);
  const [areas, setAreas] = useState<Area[]>([]);
  // Assignment (MEMBER_AGENTS): who this task belongs to, plus the optional
  // ADVISORY work brief that rides each assignment.
  const [assignees, setAssignees] = useState<TaskAssignee[]>([]);
  const [memberOptions, setMemberOptions] = useState<ProjectMemberOverview[]>([]);
  const [briefFor, setBriefFor] = useState<number | null>(null);
  const [briefDraft, setBriefDraft] = useState({ protocol: '', notes: '', acceptance: '' });
  // “Draft with my agent” (MEMBER_AGENTS §2): the LOCAL model drafts, the
  // human reviews, and the result crosses to the task's host AS A PROPOSAL.
  const [agentDraft, setAgentDraft] = useState<string | null>(null);
  const [agentBusy, setAgentBusy] = useState(false);
  const [agentMsg, setAgentMsg] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [timeEntries, setTimeEntries] = useState<TimeEntry[]>([]);
  const [activeTab, setActiveTab] = useState<'details' | 'comments' | 'files' | 'events'>('details');
  const [fileAttachments, setFileAttachments] = useState<FileAttachment[]>([]);
  const [storage, setStorage] = useState<{ used: number; quota: number } | null>(null);
  // `/file` command in the description textarea: when the user types `/file`, a
  // dropdown of the task's attachments appears; selecting one inserts a
  // `[filename](/files/<id>)` hyperlink at the cursor.
  const descriptionRef = useRef<HTMLTextAreaElement | null>(null);
  const [filePicker, setFilePicker] = useState<{ open: boolean; query: string } | null>(null);
  // The highlighted row in the `/file` picker (keyboard nav: arrows or j/k).
  const [pickerActive, setPickerActive] = useState(0);
  // The attachment to highlight in the Files tab when the user clicks a /files/<id>
  // link in the rendered description.
  const [highlightedFileId, setHighlightedFileId] = useState<number | null>(null);
  // Uploaded folders show as collapsible groups; these are the open ones.
  // Project admins and the host's owner may share links and raise the quota.
  const { canManage } = useProjectRole(task?.project_id);
  const uploadArea = useRef<TaskUploadHandle>(null);
  // Confirmation dialog before linking a LOCAL attachment (it has to be uploaded
  // to the server first, which makes it visible to everyone with task access).
  const [shareConfirm, setShareConfirm] = useState<
    | { option: FileOption; slashIdx: number; pos: number; dontShowAgain: boolean }
    | null
  >(null);
  const [linkedEvents, setLinkedEvents] = useState<Event[]>([]);
  const [projectEvents, setProjectEvents] = useState<Event[]>([]);
  const [useEventDeadline, setUseEventDeadline] = useState<boolean>(
    () => localStorage.getItem(USE_EVENT_DEADLINE_KEY) === 'true'
  );
  const [isAutoSaving, setIsAutoSaving] = useState(false);
  const [previousTaskId, setPreviousTaskId] = useState<number | null>(null);
  // The task we're currently editing, kept so the switch-auto-save can tell
  // whether the form actually changed. Clicking THROUGH tasks just to view them
  // must NOT write — a needless write pulses the host, which reloads the whole
  // project dashboard on every click.
  const prevTaskSnapshot = useRef<Task | null>(null);
  const [isDescriptionExpanded, setIsDescriptionExpanded] = useState(false);
  const [isDescriptionModalOpen, setIsDescriptionModalOpen] = useState(false);
  const [isDescriptionPreview, setIsDescriptionPreview] = useState(!!seedTask?.description?.trim());
  // "More details": remembered per device, default closed; a just-created
  // task opens closed whatever the preference says.
  const [moreOpen, setMoreOpen] = useState(() => !!task && !isFreshTask(task) && storedMoreOpen());
  useEffect(() => {
    if (task) setMoreOpen(!isFreshTask(task) && storedMoreOpen());
  }, [task?.id]);
  const toggleMore = () => {
    const next = !moreOpen;
    setMoreOpen(next);
    try {
      localStorage.setItem(MORE_OPEN_KEY, next ? '1' : '0');
    } catch {
      /* cosmetic; ignore a full or blocked store */
    }
  };
  // When switching from preview → edit, capture the preview div's rendered
  // height and use it as the textarea's minHeight. Without this, a preview
  // that's tall (images, long markdown) "collapses" to the textarea's shorter
  // raw-text height — jarring and makes the cursor jump.
  const previewBoxRef = useRef<HTMLDivElement | null>(null);
  const [editMinHeight, setEditMinHeight] = useState<number | null>(null);
  // Split into document + side fields only when the editor ITSELF is wide
  // enough, in the full page and in a side pane dragged wide. Viewport
  // breakpoints lied here twice: the container is the viewport minus ~530px of
  // nav + rail, scaled by the display.
  //   narrow: one column.
  //   split:  description (and, in the page, comments) beside the side fields.
  //   wide:   the page only, ultrawide: description and comments side by side.
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [layout, setLayout] = useState<'narrow' | 'split' | 'wide'>(page ? 'split' : 'narrow');
  const layoutRef = useRef(layout);
  const prevWidthRef = useRef(0);
  useEffect(() => {
    const el = contentRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0;
      // The page splits at 700, not higher: the threshold must sit FAR from
      // real window widths. At 880 it landed within a scrollbar's width of this
      // user's editor (scrollbars appear per content height, so the layout
      // flapped per task, which read as "unbound values"). The side pane
      // (340-900px, dragged by hand) splits from 620.
      // Ultrawide (page only) enters at 1600 and leaves below 1500, so a
      // scrollbar's width can't flap it.
      const wideNow = page && (w >= 1600 || (layoutRef.current === 'wide' && w >= 1500));
      const next = wideNow ? 'wide' : w >= (page ? 700 : 620) ? 'split' : 'narrow';
      layoutRef.current = next;
      setLayout(next);
      // Reset scroll when the editor is un-hidden (width goes 0 → non-zero).
      // Without this, a stale scroll position from before the pane was
      // collapsed traps the user below the fold — the title and description
      // become inaccessible until they manually scroll up.
      if (page && prevWidthRef.current === 0 && w > 0) {
        el.scrollTo(0, 0);
      }
      prevWidthRef.current = w;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [page, task?.id != null]);
  const split = layout !== 'narrow';
  const wide = layout === 'wide';

  // The form as plain data (lib/taskForm.ts), and the latest one in a ref: the
  // save on close runs from a cleanup closure that would otherwise hold the
  // first render's state.
  const form: TaskForm = { title, description, status, priority, prefix, cost, currency, deadline, areaId };
  const latestFormRef = useRef<{ taskId: number | null; form: TaskForm }>({ taskId: null, form });
  latestFormRef.current = { taskId: formTaskId, form };
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;
  const mountedRef = useRef(true);
  // Delete pressed on this task with this form: its edits are thrown away, not
  // saved into the Bin. It stops matching on the next edit, and clears when the
  // parent reports the delete failed.
  const deletingRef = useRef<{ taskId: number; form: TaskForm } | null>(null);
  const isDeleting = (taskId: number, f: TaskForm) =>
    deletingRef.current?.taskId === taskId && formsEqual(f, deletingRef.current.form);

  /** Send `input` for `base` to the host and remember the answer, so an editor
   * that reopens from an older copy shows it (lib/taskForm.ts, saved copies). */
  const saveToHost = async (base: Task, input: UpdateTaskInput, seq = beginSave()): Promise<Task> =>
    rememberSaved(base, await updateTaskApi(base.id, input), seq);
  // The last form the save on close sent, so ✕ then unmount sends it once even
  // when the pending copy can't show it (a cleared cost, deadline or area).
  const sentRef = useRef<{ taskId: number; form: TaskForm } | null>(null);

  /** Save the open form if it holds an edit. Every way of leaving the editor
   * runs it: closing the pane, a tab, page or view change (unmount), and the
   * restart into an update (lib/restartFlush.ts). The switch to another task
   * has its own save below. Rejects when the save fails. */
  const flushRef = useRef<() => Promise<void>>(async () => {});
  flushRef.current = async () => {
    const { taskId, form: f } = latestFormRef.current;
    const base = prevTaskSnapshot.current;
    // The form must belong to the task the snapshot is of: mid-switch it holds
    // the previous task's values, and the switch save owns them.
    if (taskId == null || !base || base.id !== taskId) return;
    if (!isFormSavable(f) || !isFormDirty(f, base) || isDeleting(taskId, f)) return;
    if (sentRef.current?.taskId === taskId && formsEqual(sentRef.current.form, f)) return;
    // Mark it saved now, so a second flush (✕ then unmount) doesn't send it
    // again, and remember the pending copy before the first await: a view that
    // reopens this task meanwhile reads the edit.
    const pending = applyForm(base, f);
    const seq = beginSave();
    prevTaskSnapshot.current = pending;
    sentRef.current = { taskId, form: f };
    rememberPending(base, pending, seq);
    try {
      const saved = await saveToHost(base, formToUpdate(f), seq);
      if (prevTaskSnapshot.current === pending) prevTaskSnapshot.current = saved;
      // After an unmount the parent may be gone or showing something else.
      if (mountedRef.current) onSaveRef.current(saved);
    } catch (e) {
      forgetPending(pending);
      if (prevTaskSnapshot.current === pending) prevTaskSnapshot.current = base;
      if (sentRef.current?.form === f) sentRef.current = null;
      throw e;
    }
  };
  if (flushOnClose) flushOnClose.current = () => flushRef.current();

  useEffect(() => {
    mountedRef.current = true;
    const flush = () => flushRef.current();
    // The restart path hears a failed save (it asks before losing edits).
    const offRestart = onBeforeRestart(flush);
    return () => {
      mountedRef.current = false;
      offRestart();
      flush().catch((e) => console.warn('Auto-save on close failed:', e));
    };
  }, []);

  // Auto-save when switching tasks
  useEffect(() => {
    if (!task) return;

    const autoSave = async () => {
      // Skip if this is the first render
      if (previousTaskId === null) {
        setPreviousTaskId(task.id);
        // The copy the form opened on (the first render's), if it's this task.
        prevTaskSnapshot.current = seedTask?.id === task.id ? seedTask : freshest(task);
        return;
      }

      // Skip if same task (shouldn't happen, but safety check)
      if (previousTaskId === task.id) {
        return;
      }

      // task.id changed → the form state still holds the PREVIOUS task's data.
      // Only write it back if the user actually edited something; otherwise
      // clicking through tasks to view them would write the previous one every
      // time, and the resulting host pulse reloads the whole dashboard.
      const prev = prevTaskSnapshot.current;
      const prevId = previousTaskId;
      setPreviousTaskId(task.id);
      prevTaskSnapshot.current = freshest(task);
      const sent = sentRef.current?.taskId === prevId && formsEqual(sentRef.current.form, form);
      if (prev && prev.id === prevId && formTaskId === prevId && isFormSavable(form) && isFormDirty(form, prev)
        && !isDeleting(prevId, form) && !sent) {
        setIsAutoSaving(true);
        const pending = applyForm(prev, form);
        const seq = beginSave();
        rememberPending(prev, pending, seq);
        try {
          // Save the old task (prev), not the one now open.
          onSave(await saveToHost(prev, formToUpdate(form), seq));
        } catch (error) {
          forgetPending(pending);
          console.error('Auto-save failed:', error);
        } finally {
          setIsAutoSaving(false);
        }
      }
    };

    autoSave();
  }, [task?.id]);

  useEffect(() => {
    if (!task) return;

    // Update local state when the task changes. Seed from the newest copy this
    // window has: the one handed in can predate a save made on close.
    const t = freshest(task);
    const seed = formFromTask(t);
    setTitle(seed.title);
    setDescription(seed.description);
    setStatus(seed.status as Task['status']);
    setPriority(seed.priority as Task['priority']);
    setPrefix(seed.prefix);
    setCost(seed.cost);
    setCurrency(seed.currency);
    setIsDescriptionPreview(!!t.description?.trim()); // show rendered content (images!) first
    setEditMinHeight(null); // reset the captured height on task switch
    setDeadline(seed.deadline);
    setAreaId(seed.areaId);
    setPinned(t.pinned || false);
    setFormTaskId(t.id); // batched with the values above: one render has both
    deletingRef.current = null;
    sentRef.current = null;
    // The parent's copy is older: hand it the newer one (title bar, lists).
    // Safe in this effect: the parent's new copy has the same id, so it
    // doesn't run again.
    if (t !== task) onSave(t);
    loadTimeData();
    loadAreas();
    loadAssignees();
    loadFiles();
    loadLinkedEvents();
    loadProjectEvents();
  }, [task?.id]);

  // Sync pin state when task.pinned changes externally (e.g. from TaskCard's pin button)
  useEffect(() => {
    if (!task) return;
    setPinned(task.pinned || false);
  }, [task?.pinned]);

  useEffect(() => {
    localStorage.setItem(USE_EVENT_DEADLINE_KEY, String(useEventDeadline));
  }, [useEventDeadline]);

  const loadAreas = async () => {
    if (!task) return;
    try {
      const projectAreas = await getAreas(task.project_id);
      setAreas(projectAreas);
    } catch (error) {
      console.error('Failed to load areas:', error);
    }
  };

  const loadAssignees = async () => {
    if (!task) return;
    try {
      setAssignees(await getAssignees(task.id));
    } catch {
      setAssignees([]); // older host / local build without the table — hide quietly
    }
    try {
      setMemberOptions(await getProjectMemberOverview(task.project_id));
    } catch {
      setMemberOptions([]);
    }
  };

  const actingUserId = () => Number(localStorage.getItem('currentUserId')) || 1;

  const handleAssign = async (userId: number) => {
    if (!task) return;
    try {
      await assignTask(task.id, userId, actingUserId(), null);
      await loadAssignees();
    } catch (e) {
      alert(`Could not assign: ${e instanceof Error ? e.message : e}`);
    }
  };

  const handleAssignContact = async (contactId: number) => {
    if (!task) return;
    try {
      await assignContact(task.id, contactId, actingUserId());
      await loadAssignees();
    } catch (e) {
      alert(`Could not assign: ${e instanceof Error ? e.message : e}`);
    }
  };

  const handleUnassign = async (a: TaskAssignee) => {
    if (!task) return;
    try {
      if (a.kind === 'contact' && a.contact_id != null) await unassignContact(task.id, a.contact_id);
      else if (a.user_id != null) await unassignTask(task.id, a.user_id);
      if (briefFor === a.user_id) setBriefFor(null);
      await loadAssignees();
    } catch (e) {
      alert(`Could not unassign: ${e instanceof Error ? e.message : e}`);
    }
  };

  /** Open the brief editor for one MEMBER assignee, seeded from what's stored.
   * Contacts have no brief — a brief addresses the assignee's tooling. */
  const openBrief = (a: TaskAssignee) => {
    if (a.kind !== 'user' || a.user_id == null) return;
    setBriefDraft({
      protocol: a.brief?.protocol ?? '',
      notes: a.brief?.notes ?? '',
      acceptance: a.brief?.acceptance ?? '',
    });
    setBriefFor(briefFor === a.user_id ? null : a.user_id);
  };

  /** Re-assign = upsert: same assignee, refreshed brief. Empty fields drop out
   * so a cleared brief stores as null, not `{}`. */
  const saveBrief = async (userId: number) => {
    if (!task) return;
    const entries = Object.entries(briefDraft).filter(([, v]) => v.trim() !== '');
    const brief = entries.length ? Object.fromEntries(entries.map(([k, v]) => [k, v.trim()])) : null;
    try {
      await assignTask(task.id, userId, actingUserId(), brief);
      setBriefFor(null);
      await loadAssignees();
    } catch (e) {
      alert(`Could not save brief: ${e instanceof Error ? e.message : e}`);
    }
  };

  /** MY assignment on this task (if any) — gates the agent-draft affordance. */
  const myAssignment = assignees.find((a) => a.kind === 'user' && a.user_id === actingUserId());
  const assignedKeys = useMemo(() => new Set(assignees.map(assigneeKey)), [assignees]);

  /** Draft a reply to this task on the LOCAL engine. The task + brief are the
   * prompt; the model only writes prose — it holds no tools and the output
   * goes nowhere until the human submits it through the host's gate. */
  const draftWithAgent = async () => {
    if (!task) return;
    setAgentBusy(true);
    setAgentMsg(null);
    try {
      const brief = myAssignment?.brief;
      const prompt = [
        `Task: ${task.title}`,
        task.description ? `Description:\n${task.description}` : null,
        brief?.notes ? `Work brief notes:\n${brief.notes}` : null,
        brief?.acceptance ? `Acceptance criteria:\n${brief.acceptance}` : null,
        `\nWrite a focused draft response for this task — the work product itself, not a plan. Plain text, no preamble.`,
      ].filter(Boolean).join('\n\n');
      const r = await runLocalAgentTask({ task_class: 'librarian', prompt });
      setAgentDraft(r.text.trim());
      setAgentMsg(r.model ? `Drafted by ${r.model} on this machine.` : 'Drafted on this machine.');
    } catch (e) {
      setAgentMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setAgentBusy(false);
    }
  };

  /** Submit the (possibly edited) draft to the task's host as a gated
   * proposal, attributed “(via agent)”. Nothing applies until approved. */
  const submitDraft = async () => {
    if (!task || !agentDraft?.trim()) return;
    setAgentBusy(true);
    try {
      const r = await submitProposal(task.project_id, 'create_comment', { task_id: task.id, content: agentDraft.trim() }, true);
      setAgentDraft(null);
      setAgentMsg(`Proposal #${r.id} submitted — it applies once approved (see Assistant › Activity).`);
    } catch (e) {
      setAgentMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setAgentBusy(false);
    }
  };

  const loadTimeData = async () => {
    if (!task) return;
    try {
      const [entries, total] = await Promise.all([
        getTimeEntries(task.id),
        getTaskTotalTime(task.id),
      ]);
      setTimeEntries(entries);
      setTaskTime(task.id, total); // Update store so task card shows updated time
    } catch (error) {
      console.error('Failed to load time data:', error);
    }
  };

  // When the user clicks a /files/<id> link in the rendered description, switch
  // to the Files tab and scroll the referenced file into view + flash it.
  // useCallback so MarkdownPreview's memo sees a stable onFileOpen and skips
  // re-rendering (a fresh inline arrow each render would re-run its components
  // memo and remount every DaemonImage — the image-flashes-on-every-keystroke
  // bug). setState identities are stable, so [] deps are correct here.
  // The task's files as the browser shows them.
  const fileEntries = useMemo<FileEntry[]>(
    () =>
      fileAttachments.map((a) => ({
        key: `a-${a.id}`,
        kind: 'attachment',
        id: a.id,
        name: a.file_name,
        relPath: a.rel_path ?? null,
        type: a.file_type,
        size: a.storage_size || a.file_size || 0,
        createdAt: a.created_at,
        uploadedBy: a.uploaded_by,
        taskId: a.task_id,
        shared: !!a.is_shared,
        localPath: a.file_path || undefined,
        aiIncluded: a.ai_included,
      })),
    [fileAttachments],
  );
  const handleDescriptionFileOpen = useCallback((id: number) => {
    setHighlightedFileId(id);
    setActiveTab('files');
  }, []);
  useEffect(() => {
    if (highlightedFileId == null) return;
    // The browser opens the file's folder, selects it and scrolls to it; the
    // id clears after a beat so the same link works again.
    const t = setTimeout(() => setHighlightedFileId(null), 4000);
    return () => clearTimeout(t);
  }, [highlightedFileId]);

  // The `/file` picker's option list (images get a link + an embed row). Memo'd
  // so the textarea's onKeyDown handler and the picker see the same list, and
  // so the picker doesn't re-render on every keystroke that doesn't change it.
  const pickerOptions = useMemo(
    () => buildFileOptions(fileAttachments, filePicker?.query ?? ''),
    [fileAttachments, filePicker?.query],
  );
  // Which attachment IDs are referenced in the task's description (via
  // `![...](/files/N)` or `[...](/files/N)`). Unreferenced images are the
  // orphaned-attachment problem: a paste that didn't persist (the old bug)
  // left the blob on disk with no description reference. Surfacing this lets
  // the user see at a glance which files are safe to clean up.
  const referencedFileIds = useMemo(() => {
    const ids = new Set<number>();
    const re = /\/files\/(\d+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(description))) ids.add(Number(m[1]));
    return ids;
  }, [description]);
  // Reset the keyboard highlight whenever the picker opens or the query filters
  // the list — a stale index could point past the end or at the wrong row.
  useEffect(() => { setPickerActive(0); }, [filePicker?.open, filePicker?.query]);

  // Auto-save when pinned state changes
  useEffect(() => {
    if (!task) return;
    // Skip on initial mount/load
    if (task.pinned === pinned) return;

    const savePinnedState = async () => {
      try {
        console.log('Auto-saving pinned state change...');
        const input: UpdateTaskInput = {
          pinned: pinned,
        };
        const saved = await saveToHost(task, input);
        // The pin is saved: a later save of the form mustn't carry the old one.
        const snap = prevTaskSnapshot.current;
        if (snap?.id === task.id) prevTaskSnapshot.current = { ...snap, pinned: saved.pinned, updated_at: saved.updated_at };
        onSave(saved);
        console.log('Pinned state auto-saved');
      } catch (error) {
        console.error('Failed to auto-save pinned state:', error);
      }
    };

    savePinnedState();
  }, [pinned]);

  const loadFiles = async () => {
    if (!task) return;
    try {
      const attachments = await getFileAttachments(task.id);
      setFileAttachments(attachments);
    } catch (error) {
      console.error('Failed to load file attachments:', error);
    }
    try {
      setStorage(await getProjectStorage(task.project_id));
    } catch (error) {
      console.error('Failed to load project storage:', error);
    }
  };

  const fmtBytes = (n: number) => {
    if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
    if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
    return `${n} B`;
  };

  const handleToggleShare = async (attachment: FileAttachment) => {
    try {
      if (attachment.is_shared) {
        await unshareFileAttachment(attachment.id);
      } else {
        // Sharing a LOCAL attachment: the file_path points at the CLIENT's
        // disk, but share_file_attachment runs on the HOST (a different
        // machine in online mode) and can't read it → "the local file no
        // longer exists on this machine". So in the Tauri desktop, read the
        // bytes HERE and upload them via /files/:id/restore (which writes
        // the blob on the host + flips is_shared). Same pattern as the
        // FilesTab "push to host" flow. Falls back to the host-side read
        // for web/mobile (where the host IS the local machine).
        if (isTauri() && hasDaemon() && attachment.file_path) {
          const { invoke } = await import('@tauri-apps/api/core');
          const buf = await invoke<ArrayBuffer>('read_local_file', { path: attachment.file_path });
          await restoreSharedFile(attachment.id, new File([buf], attachment.file_name, { type: attachment.file_type || 'application/octet-stream' }));
        } else {
          await shareFileAttachment(attachment.id);
        }
      }
      await loadFiles();
    } catch (error) {
      alert(`Could not change sharing: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const handleSetQuota = async () => {
    if (!task) return;
    const currentMb = Math.round((storage?.quota ?? 0) / 1024 / 1024);
    const input = prompt('Shared-storage limit for this project (MB):', String(currentMb || 256));
    if (input == null) return;
    const mb = Number(input);
    if (!Number.isFinite(mb) || mb < 0) {
      alert('Enter a number of megabytes.');
      return;
    }
    try {
      await setProjectQuota(task.project_id, Math.round(mb * 1024 * 1024));
      await loadFiles();
    } catch (error) {
      alert(`Could not set the limit: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const loadLinkedEvents = async () => {
    if (!task) return;
    try {
      const evs = await getTaskEvents(task.id);
      setLinkedEvents(evs);
    } catch (error) {
      console.error('Failed to load linked events:', error);
    }
  };

  const loadProjectEvents = async () => {
    if (!task) return;
    try {
      const evs = await getProjectEvents(task.project_id, false);
      setProjectEvents(evs);
    } catch (error) {
      console.error('Failed to load project events:', error);
    }
  };

  const handleEventSelectionChange = async (newSelectedIds: number[]) => {
    if (!task) return;
    const currentIds = linkedEvents.map((e) => e.id);
    const toLink = newSelectedIds.filter((id) => !currentIds.includes(id));
    const toUnlink = currentIds.filter((id) => !newSelectedIds.includes(id));
    if (toLink.length === 0 && toUnlink.length === 0) return;

    try {
      await Promise.all([
        ...toLink.map((id) => linkEventToTask(id, task.id)),
        ...toUnlink.map((id) => unlinkEventFromTask(id, task.id)),
      ]);

      if (useEventDeadline && toLink.length > 0) {
        const newlyLinked = projectEvents.filter((e) => toLink.includes(e.id));
        if (newlyLinked.length > 0) {
          const earliest = newlyLinked.reduce((a, b) =>
            new Date(a.event_date).getTime() < new Date(b.event_date).getTime() ? a : b
          );
          const newDeadline = toLocalDateString(new Date(earliest.event_date));
          setDeadline(newDeadline);
          const updated = await saveToHost(task, {
            deadline: new Date(newDeadline).toISOString(),
          });
          onSave(updated);
        }
      }

      await loadLinkedEvents();
    } catch (error) {
      console.error('Failed to update event links:', error);
      alert(`Failed to update event links: ${error}`);
    }
  };

  const handleUnlinkEvent = async (eventId: number) => {
    if (!task) return;
    try {
      await unlinkEventFromTask(eventId, task.id);
      await loadLinkedEvents();
    } catch (error) {
      console.error('Failed to unlink event:', error);
      alert(`Failed to unlink event: ${error}`);
    }
  };

  const handleAddFiles = async () => {
    if (!task) return;
    console.log('handleAddFiles: Starting file selection');
    try {
      console.log('handleAddFiles: Opening file dialog');
      const selected = await open({
        multiple: true,
        title: 'Select files to attach',
      });

      console.log('handleAddFiles: Dialog closed, selected:', selected);

      if (!selected) {
        console.log('handleAddFiles: No files selected');
        return;
      }

      const files = Array.isArray(selected) ? selected : [selected];
      console.log('handleAddFiles: Processing', files.length, 'file(s)');

      for (const filePath of files) {
        console.log('handleAddFiles: Processing file:', filePath);
        const fileName = filePath.split('/').pop() || filePath.split('\\').pop() || filePath;
        const fileType = fileName.split('.').pop();

        console.log('handleAddFiles: Creating attachment for:', fileName, 'type:', fileType);
        await createFileAttachment({
          task_id: task.id,
          file_path: filePath,
          file_name: fileName,
          file_type: fileType,
        });
        console.log('handleAddFiles: Attachment created successfully');
      }

      console.log('handleAddFiles: Reloading file list');
      await loadFiles();
      console.log('handleAddFiles: Files loaded successfully');
    } catch (error) {
      console.error('handleAddFiles: Error occurred:', error);
      alert(`Failed to add files: ${error}`);
    }
  };

  const handleOpenFile = async (attachment: FileAttachment) => {
    try {
      await openPath(attachment.file_path);
    } catch (error) {
      console.error('Failed to open file:', error);
      alert(`Failed to open file: ${error}`);
    }
  };

  // "Show in folder": where this file lives on THIS machine — the member-side
  // way to find the project's local directories. (Replaces "verify", which
  // checked the host's disk and never told a member anything useful.)
  const [revealNote, setRevealNote] = useState<Record<number, RevealResult & { path: string }>>({});
  const handleShowInFolder = async (attachment: FileAttachment) => {
    try {
      const r = await revealLocalPath(attachment.file_path);
      setRevealNote((m) => {
        const next = { ...m };
        if (r.outcome === 'file') delete next[attachment.id];
        else next[attachment.id] = { ...r, path: attachment.file_path };
        return next;
      });
    } catch (error) {
      alert(`Couldn't open the folder: ${error}`);
    }
  };

  const handleRelocateFile = async (attachment: FileAttachment) => {
    try {
      const selected = await open({
        multiple: false,
        title: 'Select new file location',
        defaultPath: attachment.file_name,
      });

      if (!selected || Array.isArray(selected)) return;

      await updateFileAttachment(attachment.id, { file_path: selected });
      setRevealNote((m) => {
        const next = { ...m };
        delete next[attachment.id];
        return next;
      });
      await loadFiles();
    } catch (error) {
      console.error('Failed to relocate file:', error);
      alert('Failed to relocate file');
    }
  };

  const saveTask = async (descOverride?: string) => {
    if (!task) return;
    setIsSaving(true);
    try {
      const base = prevTaskSnapshot.current?.id === task.id ? prevTaskSnapshot.current : task;
      const sentForm = { ...form, description: descOverride ?? description };
      const updatedTask = await saveToHost(base, formToUpdate(sentForm));
      prevTaskSnapshot.current = updatedTask; // the save on close compares against this
      sentRef.current = { taskId: task.id, form: sentForm };
      onSave(updatedTask);
    } catch (error) {
      console.error('Failed to update task:', error);
      alert('Failed to update task');
    } finally {
      setIsSaving(false);
    }
  };

  const handleSave = () => saveTask();

  /** Insert a `/file` option at the cursor and PERSIST immediately. The save is
   * the fix for the "pasted image / file link vanishes when the task is opened
   * in another view" bug: without it the `![image](/files/N)` or
   * `[name](/files/N)` text lived only in this editor's local React state, so
   * a different TaskEditor instance (Home vs Project > Tasks) mounting fresh
   * loaded the server's stale description — minus the reference. Saving right
   * here means the next view to mount reads the reference from the server. */
  const insertFileOption = async (option: FileOption, slashIdx: number, pos: number) => {
    const ta = descriptionRef.current;
    if (!ta || !task) return;
    const { att, mode } = option;
    const text = safeLinkText(att.file_name);
    const link = mode === 'embed' ? `![${text}](/files/${att.id})` : `[${text}](/files/${att.id})`;
    const next = ta.value.slice(0, slashIdx) + link + ta.value.slice(pos);
    setDescription(next);
    setFilePicker(null);
    await saveTask(next); // persist so the reference survives a view switch
    requestAnimationFrame(() => {
      const caret = slashIdx + link.length;
      ta.focus();
      ta.setSelectionRange(caret, caret);
    });
  };

  /** Pick a `/file` option. If the attachment is LOCAL (not shared yet), prompt
   * before uploading it to the server — a shared task's members can't reach a
   * teammate's local disk, so a local ref would render as a broken link for
   * them. Sharing makes it visible to everyone with task access, hence the
   * warning. Shared attachments skip straight to insertion. */
  const pickOption = (option: FileOption) => {
    const ta = descriptionRef.current;
    if (!ta) { setFilePicker(null); return; }
    const pos = ta.selectionStart;
    const before = ta.value.slice(0, pos);
    const slashIdx = before.lastIndexOf('/file');
    if (slashIdx < 0) { setFilePicker(null); return; }
    if (!option.att.is_shared && shouldWarnLocalFileLink()) {
      setShareConfirm({ option, slashIdx, pos, dontShowAgain: false });
      return;
    }
    void insertFileOption(option, slashIdx, pos);
  };

  // Fixed-width right rail by default; fills its parent inside DetailPane.
  const rootClass = fill
    ? 'bg-base flex flex-col h-full w-full'
    : 'bg-base border-l border-gilt-a flex flex-col h-full';
  const rootStyle = fill ? undefined : { width: `${width}px` };

  // Early return for null task - AFTER all hooks
  if (!task) {
    return (
      <div className={rootClass} style={rootStyle}>
        <div className="flex-1 flex items-center justify-center text-subtext-0 p-8 text-center">
          <div>
            <svg className="w-16 h-16 mx-auto mb-4 opacity-50" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
            <p className="text-lg font-medium">No Task Selected</p>
            <p className="text-sm mt-2">Select a task to view details</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={rootClass} style={rootStyle}>
      {/* No title bar: the surrounding DetailPane header already shows the task
          title (and in the Tasks tab the selected row supplies the context).
          Delete lives at the bottom; "Active" sits beside "Pin task". */}

      {/* Tabs */}
      <div role="tablist" aria-label="Task sections" className={`flex-shrink-0 border-b border-gilt-b ${page ? 'flex justify-center' : 'grid grid-cols-4'}`}>
        {([
          ['details', 'Details'],
          ['comments', 'Comments'],
          ['files', `Files (${fileAttachments.length})`],
          ['events', `Events (${linkedEvents.length})`],
        ] as const).map(([id, label]) => (
          <button
            key={id}
            role="tab"
            aria-selected={activeTab === id}
            onClick={() => setActiveTab(id)}
            className={`g-dtab ${page ? 'px-6' : 'min-w-0 !px-1.5 truncate'}`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Content. overflow-x-hidden: wide pasted content (tables) scrolls
          inside its own box, never the whole app sideways. */}
      <div ref={contentRef} className="flex-1 min-w-0 overflow-y-auto overflow-x-hidden px-[22px] pt-5 pb-7">
        {activeTab === 'comments' ? (
          <div className="h-full">
            <CommentList taskId={task.id} />
          </div>
        ) : activeTab === 'details' ? (
          <div className={split ? 'flex flex-row items-start gap-7' : 'flex flex-col gap-[18px]'}>
            {/* MAIN: the task reads like a document — title, then description.
                Narrow, the side fields follow it in one column; wide, they sit
                beside it; ultrawide (page), comments sit beside the description. */}
            <div className={split ? `flex-1 min-w-0 ${wide ? 'grid grid-cols-2 gap-7 items-start' : 'flex flex-col gap-[18px]'}` : 'flex flex-col gap-[18px]'}>
             <div className="flex flex-col gap-[18px] min-w-0">
              {/* Who can see it sits behind "More details", so a restricted
                  task says so here, by its title. */}
              {page ? (
                <div className="flex flex-col gap-2">
                  {isRestricted(task, areas) && (
                    <div className="flex"><TaskVisibilityBadge task={task} areas={areas} /></div>
                  )}
                  <input
                    type="text"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder="Task title"
                    aria-label="Title"
                    className="g-field text-xl font-semibold"
                  />
                </div>
              ) : (
                <div>
                  <div className="flex items-center justify-between gap-2 mb-1.5">
                    <label className="g-flbl !mb-0">
                      Title
                    </label>
                    <TaskVisibilityBadge task={task} areas={areas} />
                  </div>
                  <input
                    type="text"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    className="g-field font-semibold"
                  />
                </div>
              )}

              {/* Description: a gilt box. Defaults to the rendered view, so
                  embedded images show; click anywhere in it to edit. */}
              <div>
                <div className="flex flex-wrap items-center justify-between gap-x-2 mb-1.5">
                  <span className="g-flbl !mb-0">Description</span>
                  <div className="flex items-center flex-wrap justify-end ml-auto">
                    <button
                      type="button"
                      onClick={() => setIsDescriptionExpanded(!isDescriptionExpanded)}
                      className="g-lnk"
                      title="Toggle expanded view"
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                        {isDescriptionExpanded ? (
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
                        ) : (
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                        )}
                      </svg>
                      {isDescriptionExpanded ? 'Collapse' : 'Expand'}
                    </button>
                    <button
                      type="button"
                      onClick={() => { setEditMinHeight(null); setIsDescriptionPreview((v) => !v); }}
                      className="g-lnk"
                      title={isDescriptionPreview ? 'Edit markdown' : 'Preview rendered markdown + images'}
                    >
                      {isDescriptionPreview ? 'Edit' : 'Preview'}
                    </button>
                    <button
                      type="button"
                      onClick={() => setIsDescriptionModalOpen(true)}
                      className="g-lnk"
                      title="Open full editor"
                    >
                      Open dialogue
                    </button>
                  </div>
                </div>

              <div className={`g-card overflow-hidden ${isDescriptionPreview ? 'g-corners' : ''}`} style={{ backgroundColor: 'var(--color-mantle)' }}>
                {isDescriptionPreview ? (
                  <div
                    ref={previewBoxRef}
                    className="px-[18px] py-4 overflow-y-auto cursor-text"
                    style={{
                      minHeight: page ? '16rem' : isDescriptionExpanded ? '18rem' : '12rem',
                      maxHeight: page ? '46rem' : isDescriptionExpanded ? '40rem' : '24rem',
                    }}
                    onClick={() => {
                      // Capture the preview's rendered height so the textarea
                      // starts at the same size — no "collapse" when images
                      // make the preview taller than the raw markdown text.
                      if (previewBoxRef.current) {
                        setEditMinHeight(previewBoxRef.current.offsetHeight);
                      }
                      setIsDescriptionPreview(false);
                    }}
                    title="Click to edit"
                  >
                    {description.trim() ? (
                      <MarkdownPreview content={description} onFileOpen={handleDescriptionFileOpen} />
                    ) : (
                      <span className="text-subtext-0 text-sm">No description yet — click to write one.</span>
                    )}
                  </div>
                ) : (
                  <div className="relative">
                    <textarea
                      ref={descriptionRef}
                      value={description}
                      onChange={(e) => {
                        setDescription(e.target.value);
                        // `/file` command: detect the token immediately before the
                        // cursor. Showing a dropdown of the task's attachments turns
                        // "reference an attached file" from hand-typing a path into a
                        // pick — and the inserted link navigates to the Files tab.
                        const ta = e.target;
                        const pos = ta.selectionStart;
                        const before = ta.value.slice(0, pos);
                        const m = before.match(/(^|\n|\s)\/file(.*)$/);
                        if (m) {
                          setFilePicker({ open: true, query: m[2].trimStart() });
                        } else if (filePicker?.open) {
                          setFilePicker(null);
                        }
                      }}
                      onBlur={() => setTimeout(() => setFilePicker(null), 150)}
                      onKeyDown={(e) => {
                        // When the `/file` picker is open, the textarea owns the
                        // keys: arrows (or j/k vim-style) move the highlight,
                        // Enter selects, Escape closes. Enter-selecting is the
                        // expected autocomplete UX; Escape first for a newline.
                        if (!filePicker?.open) return;
                        const opts = pickerOptions;
                        if (e.key === 'Escape') {
                          setFilePicker(null);
                          e.preventDefault();
                          return;
                        }
                        if (e.key === 'ArrowDown' || e.key === 'j') {
                          e.preventDefault();
                          setPickerActive((i) => Math.min(i + 1, opts.length - 1));
                          return;
                        }
                        if (e.key === 'ArrowUp' || e.key === 'k') {
                          e.preventDefault();
                          setPickerActive((i) => Math.max(i - 1, 0));
                          return;
                        }
                        if (e.key === 'Enter' && opts[pickerActive]) {
                          e.preventDefault();
                          pickOption(opts[pickerActive]);
                          return;
                        }
                      }}
                      onPaste={async (e) => {
                      const item = Array.from(e.clipboardData.items).find((i) => i.type.startsWith('image/'));
                      if (!item || !task) return;
                      e.preventDefault();
                      const file = item.getAsFile();
                      if (!file) return;
                      try {
                        const att = await attachPastedImage(task.id, file);
                        const next = `${description}${description && !description.endsWith('\n') ? '\n' : ''}![image](/files/${att.id})\n`;
                        setDescription(next);
                        loadFiles();
                        setIsDescriptionPreview(true); // show the embedded image right away
                        // Persist immediately: without this, the ![image](/files/N)
                        // reference lives only in local state and vanishes when the
                        // task is opened in another view (Home vs Project > Tasks).
                        await saveTask(next);
                      } catch (err) {
                        alert(`Could not attach image: ${err instanceof Error ? err.message : String(err)}`);
                      }
                    }}
                    rows={page ? (isDescriptionExpanded ? 24 : 14) : isDescriptionExpanded ? 12 : 6}
                    style={{
                      // Match the preview mode's height so clicking to edit
                      // doesn't collapse the editor and shift the layout out
                      // from under the cursor. editMinHeight (captured from the
                      // preview div on click) prevents a tall preview with images
                      // from collapsing to the shorter raw-text textarea height.
                      minHeight: editMinHeight ?? (page ? '16rem' : isDescriptionExpanded ? '18rem' : '12rem'),
                      maxHeight: page ? '46rem' : isDescriptionExpanded ? '40rem' : '24rem',
                    }}
                    placeholder="Supports markdown — paste an image to embed it, or type /file to link an attachment"
                    className="g-read block w-full px-[18px] py-4 bg-transparent focus:outline-none text-text leading-relaxed resize-none"
                  />
                    {filePicker?.open && fileAttachments.length > 0 && (
                      <FileReferencePicker
                        options={pickerOptions}
                        activeIndex={pickerActive}
                        onActiveChange={setPickerActive}
                        onPick={pickOption}
                        onClose={() => setFilePicker(null)}
                      />
                    )}
                  </div>
                )}
              </div>
              </div>
             </div>

              {page && (
                <div className="flex flex-col gap-[18px] min-w-0">
                  {/* Discussion belongs under the document, not behind a tab —
                      "Comments should be below the task description" (field).
                      Ultrawide, it sits beside the description instead. */}
                  <div className={wide ? '' : 'pt-4 border-t border-gilt-b'}>
                    <CommentList taskId={task.id} />
                  </div>
                </div>
              )}
            </div>

            {/* SIDE: metadata, narrow — and the buttons that matter, on top.
                Time entries live behind "More details" here, in both layouts. */}
            <aside className={split ? 'w-[clamp(16rem,30%,24rem)] shrink-0 flex flex-col gap-[18px]' : 'flex flex-col gap-[18px] pt-2'}>
              {page && (
                <button
                  onClick={handleSave}
                  disabled={isSaving || !title.trim()}
                  className="g-btn g-btn-pri g-glint w-full min-h-[44px]"
                >
                  {isSaving ? 'Saving…' : 'Save changes'}
                </button>
              )}

              <div className={page ? 'g-plain p-4 flex flex-col gap-4' : 'flex flex-col gap-[18px]'}>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="g-flbl">
                      Status
                    </label>
                    <select
                      value={status}
                      onChange={(e) => setStatus(e.target.value as Task['status'])}
                      className="g-field"
                    >
                      <option value="To Do">To Do</option>
                      <option value="In Progress">In Progress</option>
                      <option value="Done">Done</option>
                      <option value="Blocked">Blocked</option>
                    </select>
                  </div>

                  <div>
                    <label className="g-flbl">
                      Priority
                    </label>
                    <select
                      value={priority}
                      onChange={(e) => setPriority(e.target.value as Task['priority'])}
                      className="g-field"
                    >
                      <option value="Low">Low</option>
                      <option value="Medium">Medium</option>
                      <option value="High">High</option>
                    </select>
                  </div>
                </div>

                <div>
                  <label className="g-flbl">
                    Deadline
                  </label>
                  <input
                    type="date"
                    value={deadline}
                    onChange={(e) => setDeadline(e.target.value)}
                    className="g-field"
                  />
                </div>

                {/* Assignees — who this task belongs to. Click a chip to edit its
                    advisory work brief (rendered on the assignee's side, never
                    executed — MEMBER_AGENTS §3). */}
                <div>
                  <label className="g-flbl">
                    Assignees
                  </label>
                  <div className="flex flex-col gap-2">
                    {assignees.length > 0 && (
                      <div className="flex flex-wrap gap-1.5">
                        {assignees.map((a) => (
                          <span
                            key={assigneeKey(a)}
                            className={`g-tag !pl-1 !pr-1.5 max-w-full ${
                              a.kind === 'user' && briefFor === a.user_id ? 'shadow-[inset_0_0_0_1px_var(--color-gold)]' : ''
                            }`}
                          >
                            <button
                              type="button"
                              onClick={() => openBrief(a)}
                              title={a.kind === 'contact' ? 'Contact — responsible, not a member' : 'Edit work brief'}
                              className={`g-hit flex items-center gap-1.5 min-w-0 text-left ${a.kind === 'user' ? 'hover:text-text' : 'cursor-default'}`}
                            >
                              <span className="g-av" style={{ width: 20, height: 20, fontSize: 8 }} aria-hidden="true">
                                {(a.display_name || a.username).slice(0, 2).toUpperCase()}
                              </span>
                              <span className="truncate">{a.display_name || a.username}</span>
                              {a.kind === 'contact' && <span className="text-[10px] text-subtext-0 shrink-0">contact</span>}
                              {a.brief && <span className="text-[10px] text-gold shrink-0">brief</span>}
                            </button>
                            <button
                              type="button"
                              onClick={() => handleUnassign(a)}
                              className="g-hit text-subtext-0 hover:text-error px-0.5"
                              title="Unassign"
                              aria-label={`Unassign ${a.display_name || a.username}`}
                            >
                              ✕
                            </button>
                          </span>
                        ))}
                      </div>
                    )}
                    {assignees.map((a) =>
                      a.kind === 'user' && briefFor === a.user_id ? (
                        <div key={assigneeKey(a)} className="g-inset !p-3 flex flex-col gap-2">
                          <span className="g-flbl !mb-0">Work brief · {a.display_name || a.username}</span>
                          <input
                            type="text"
                            value={briefDraft.protocol}
                            onChange={(e) => setBriefDraft((b) => ({ ...b, protocol: e.target.value }))}
                            placeholder="Suggested protocol slug (optional)"
                            className="g-field g-field-sm"
                          />
                          <textarea
                            value={briefDraft.notes}
                            onChange={(e) => setBriefDraft((b) => ({ ...b, notes: e.target.value }))}
                            placeholder="Notes for the assignee…"
                            rows={2}
                            className="g-field g-field-sm resize-none"
                          />
                          <textarea
                            value={briefDraft.acceptance}
                            onChange={(e) => setBriefDraft((b) => ({ ...b, acceptance: e.target.value }))}
                            placeholder="Acceptance criteria (optional)"
                            rows={2}
                            className="g-field g-field-sm resize-none"
                          />
                          <div className="flex justify-end gap-2">
                            <button type="button" onClick={() => setBriefFor(null)} className="g-btn g-btn-ghost g-btn-sm">Cancel</button>
                            <button type="button" onClick={() => a.user_id != null && saveBrief(a.user_id)} className="g-btn g-btn-pri g-btn-sm">Save brief</button>
                          </div>
                        </div>
                      ) : null
                    )}
                    <AssigneePicker
                      members={memberOptions}
                      excludeKeys={assignedKeys}
                      onPickUser={handleAssign}
                      onPickContact={handleAssignContact}
                    />
                    {/* The member-side agent flow: local draft → host proposal. */}
                    {myAssignment && hasDaemon() && (
                      <div className="pt-1 space-y-1.5">
                        {agentDraft == null ? (
                          <button
                            type="button"
                            onClick={draftWithAgent}
                            disabled={agentBusy}
                            className="g-btn g-btn-gilt g-btn-sm w-full"
                            title="Your LOCAL model drafts a response from the task + brief; you review it; it reaches the host only as a gated proposal."
                          >
                            {agentBusy ? 'Drafting on this machine…' : '🤖 Draft with my agent'}
                          </button>
                        ) : (
                          <div className="g-inset !p-3 flex flex-col gap-2">
                            <div className="g-flbl !mb-0">Agent draft — review before it goes anywhere</div>
                            <textarea
                              value={agentDraft}
                              onChange={(e) => setAgentDraft(e.target.value)}
                              rows={6}
                              className="g-field g-field-sm resize-y"
                            />
                            <div className="flex justify-end gap-2">
                              <button type="button" onClick={() => { setAgentDraft(null); setAgentMsg(null); }} className="g-btn g-btn-ghost g-btn-sm" disabled={agentBusy}>Discard</button>
                              <button type="button" onClick={submitDraft} className="g-btn g-btn-pri g-btn-sm" disabled={agentBusy || !agentDraft.trim()}>
                                {agentBusy ? 'Submitting…' : 'Submit as proposal (via agent)'}
                              </button>
                            </div>
                          </div>
                        )}
                        {agentMsg && <p className="text-[11px] text-subtext-0">{agentMsg}</p>}
                      </div>
                    )}
                  </div>
                </div>

                {/* Active task: the one the timer/ActiveTaskWidget tracks. Also
                    settable by double-clicking a task in any list. */}
                <div className="g-card outline-0 flex items-center gap-3 px-4 py-3">
                  <div className="flex-1 min-w-0">
                    <span id={`active-${task.id}`} className="flex items-center gap-2 font-semibold text-text">
                      <svg className="w-4 h-4 text-success" fill={isActive ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth={isActive ? 0 : 2} viewBox="0 0 24 24" aria-hidden="true">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
                      </svg>
                      Active task
                    </span>
                    <span className="block text-[13px] text-subtext-0">{isActive ? 'The timer is tracking it' : 'The task the timer tracks'}</span>
                  </div>
                  <button
                    onClick={() => setActiveTask(isActive ? null : task)}
                    title="The task the timer tracks. Tip: double-click a task in any list to set it active."
                    role="switch"
                    aria-checked={isActive}
                    aria-labelledby={`active-${task.id}`}
                    className="g-tog g-tog-grn"
                  >
                    <span className="g-tog-k" />
                  </button>
                </div>
              </div>

              {isAutoSaving && <p className="text-center text-xs text-gold">◆ Auto-saving…</p>}

              {/* The rest sits behind a "More details" divider (the prototype's .more),
                  so the pane doesn't open on a wall of fields. Open or closed is a
                  per-device cosmetic preference. */}
              <button
                type="button"
                onClick={toggleMore}
                aria-expanded={moreOpen}
                aria-controls={`more-${task.id}`}
                className="g-rule !min-h-[42px] !text-[12px]"
              >
                <span className="inline-flex items-center gap-2">
                  {moreOpen ? 'Fewer details' : 'More details'}
                  <svg className={`transition-transform duration-200 motion-reduce:transition-none ${moreOpen ? 'rotate-180' : ''}`} width="10" height="6" viewBox="0 0 10 6" aria-hidden="true">
                    <path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" />
                  </svg>
                </span>
              </button>

              {/* Kept mounted while closed, so a half-typed time entry survives a collapse. */}
              <div id={`more-${task.id}`} className={`g-reveal flex-col gap-[18px] ${moreOpen ? 'flex' : 'hidden'}`}>
                <div className={page ? 'g-plain p-4 flex flex-col gap-4' : 'flex flex-col gap-[18px]'}>
                  <div>
                    <label className="g-flbl">
                      Area
                    </label>
                    <select
                      value={areaId || ''}
                      onChange={(e) => setAreaId(e.target.value ? Number(e.target.value) : undefined)}
                      className="g-field"
                    >
                      <option value="">No Area</option>
                      {areas.map((area) => (
                        <option key={area.id} value={area.id}>
                          {area.restricted ? `🔒 ${area.name}` : area.name}
                        </option>
                      ))}
                    </select>
                  </div>

                  {task?.id != null && (
                    <TaskVisibilityField taskId={task.id} projectId={task.project_id} areas={areas} savedAreaId={task.area_id} />
                  )}

                  <div>
                    <label className="g-flbl">
                      Prefix
                    </label>
                    <input
                      type="text"
                      value={prefix}
                      onChange={(e) => setPrefix(e.target.value)}
                      placeholder="e.g., FEAT, BUG, DOCS"
                      className="g-field"
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="g-flbl">
                        Cost
                      </label>
                      <input
                        type="number"
                        step="0.01"
                        value={cost}
                        onChange={(e) => setCost(e.target.value)}
                        placeholder="0.00"
                        className="g-field"
                      />
                    </div>

                    <div>
                      <label className="g-flbl">
                        Currency
                      </label>
                      <input
                        type="text"
                        value={currency}
                        onChange={(e) => setCurrency(e.target.value)}
                        placeholder="USD, EUR, GBP..."
                        maxLength={10}
                        className="g-field"
                      />
                    </div>
                  </div>

                  <div className="g-togrow border-t border-gilt-b">
                    <span id={`pin-${task.id}`} className="flex-1 flex items-center gap-2 font-semibold text-text">
                      <svg
                        className="w-4 h-4 text-gold"
                        fill={pinned ? "currentColor" : "none"}
                        stroke="currentColor"
                        strokeWidth={pinned ? 0 : 2}
                        viewBox="0 0 24 24"
                        aria-hidden="true"
                      >
                        <path d="M16 12V4H17V2H7V4H8V12L6 14V16H11.2V22H12.8V16H18V14L16 12Z" />
                      </svg>
                      Pin task
                    </span>
                    <button
                      onClick={() => setPinned(!pinned)}
                      role="switch"
                      aria-checked={pinned}
                      aria-labelledby={`pin-${task.id}`}
                      className="g-tog"
                    >
                      <span className="g-tog-k" />
                    </button>
                  </div>
                </div>

                <TimeEntriesList
                  entries={timeEntries}
                  onEntriesChange={loadTimeData}
                  projectId={task.project_id}
                />

                <div className="text-center text-xs leading-[1.8] text-subtext-0 tabular-nums">
                  <p>Created {new Date(task.created_at).toLocaleString()}</p>
                  <p>Updated {new Date(task.updated_at).toLocaleString()}</p>
                  {task.completed_at && <p>Completed {new Date(task.completed_at).toLocaleString()}</p>}
                </div>

                <div className="grid grid-cols-[repeat(auto-fit,minmax(9rem,1fr))] gap-2.5">
                  {/* Pop the task out into its own OS window (desktop only;
                      no-op in a window that's already standalone). Inside a
                      DetailPane the button sits in its top row instead. */}
                  {!fill && isTauri() && !new URLSearchParams(window.location.search).get('pane') && (
                    <button
                      onClick={() => void openTaskWindow(task.id, task.project_id, task.title)}
                      title="Open this task in a separate window"
                      className="g-btn g-btn-ghost w-full"
                    >
                      Open in new window
                    </button>
                  )}

                  {/* Delete lives here in BOTH modes now (the old title-bar trash
                      was removed as redundant with the DetailPane header). */}
                  <button
                    onClick={() => {
                      const mark = { taskId: task.id, form };
                      deletingRef.current = mark;
                      void Promise.resolve(onDelete()).then((ok) => {
                        // The delete failed and the task stays open: its edits save again.
                        if (ok === false && deletingRef.current === mark) deletingRef.current = null;
                      });
                    }}
                    title="Restorable from the Bin"
                    className="g-btn g-btn-danger w-full"
                  >
                    Move to Bin
                  </button>
                </div>
              </div>
            </aside>
          </div>
        ) : activeTab === 'files' ? (
          <TaskUploadArea
            ref={uploadArea}
            buttons={false}
            taskId={task.id}
            projectId={task.project_id}
            taskTitle={task.title}
            canManage={canManage}
            enabled={hasDaemon()}
            onUploaded={() => void loadFiles()}
          >
            {/* Add Files Button — these attachments are PATH references to a
                local disk, so a browser member gets an honest note instead of
                a picker that could only produce a path their host can't read.
                Uploads (shared files) live in the project's Files tab. */}
            {!hasFilePaths() ? (
              <p className="g-inset text-[13px] text-subtext-0">
                File links point at a path on the desktop app's own machine — open this task in the
                desktop app to add or open them.{hasDaemon() ? ' Files you upload here are stored on the host.' : ''}
              </p>
            ) : (
            <button
              onClick={handleAddFiles}
              className="g-btn g-btn-pri g-glint w-full min-h-[44px]"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
              Add files
            </button>
            )}

            {/* Shared-storage allocation for this project */}
            {storage && (
              <div className="g-inset">
                <div className="flex items-center justify-between gap-2 text-[13px] text-subtext-1 mb-2">
                  <span>Shared storage · <b className="tabular-nums text-text">{fmtBytes(storage.used)}</b> of {fmtBytes(storage.quota)}</span>
                  <button onClick={handleSetQuota} className="g-lnk">Set limit</button>
                </div>
                <div className="g-pbar">
                  <div
                    className={`h-full ${storage.used >= storage.quota ? 'bg-error' : 'bg-gold'}`}
                    style={{ width: `${storage.quota > 0 ? Math.min(100, (storage.used / storage.quota) * 100) : 0}%` }}
                  />
                </div>
              </div>
            )}

            {/* The task's files: the shared browser, scoped to this task. */}
            <div className="g-plain !p-0 overflow-hidden">
              <FileBrowser
                projectId={task.project_id}
                rootLabel="Task files"
                workspaceId={task.workspaceId}
                taskId={task.id}
                entries={fileEntries}
                onReload={() => void loadFiles()}
                flow
                focusKey={highlightedFileId != null ? `a-${highlightedFileId}` : null}
                onUpload={hasDaemon() ? (folder, to) => uploadArea.current?.pick(folder, to.dir) : undefined}
                deleteEntry={(e) => deleteFileAttachment(e.id)}
                openLocal={(e) => {
                  const a = fileAttachments.find((x) => x.id === e.id);
                  if (a) void handleOpenFile(a);
                }}
                extraTags={(e) => {
                  const referenced = referencedFileIds.has(e.id);
                  if (referenced)
                    return (
                      <span className="g-tag g-tag-ok !min-h-[18px] !px-1.5 !text-[10px] shrink-0" title="Referenced in the task description">
                        in description
                      </span>
                    );
                  if ((e.type || '').startsWith('image/'))
                    return (
                      <span
                        className="g-tag g-tag-warn !min-h-[18px] !px-1.5 !text-[10px] shrink-0"
                        title="Not referenced in the description — safe to delete if it was a stray paste"
                      >
                        not in description
                      </span>
                    );
                  return null;
                }}
                extraMenu={(e) => {
                  const a = fileAttachments.find((x) => x.id === e.id);
                  if (!a) return [];
                  return [
                    {
                      label: a.is_shared ? 'Stop sharing with the team' : 'Share with the team',
                      icon: '⇪',
                      onClick: () => void handleToggleShare(a),
                    },
                    ...(hasFilePaths() && a.file_path
                      ? [{ label: 'Show in folder', icon: '📂', onClick: () => void handleShowInFolder(a) }]
                      : []),
                  ];
                }}
                extraDetails={(e) => {
                  const a = fileAttachments.find((x) => x.id === e.id);
                  if (!a) return null;
                  const note = revealNote[a.id];
                  return (
                    <div className="space-y-2">
                      <div className="flex flex-wrap gap-2">
                        <button
                          onClick={() => void handleToggleShare(a)}
                          className="g-btn g-btn-sm g-btn-ghost flex-1"
                          title={a.is_shared ? 'Stop sharing with the team' : 'Share with the team (copies into the project allocation)'}
                        >
                          {a.is_shared ? 'Stop sharing' : 'Share with the team'}
                        </button>
                        {hasFilePaths() && a.file_path && (
                          <button onClick={() => void handleShowInFolder(a)} className="g-btn g-btn-sm g-btn-ghost flex-1" title="Show in folder on this machine">
                            Show in folder
                          </button>
                        )}
                      </div>
                      {note && (
                        <div className="g-inset !px-3 !py-2.5 text-xs space-y-1.5">
                          <p className="text-subtext-1">
                            {note.outcome === 'folder' ? (
                              <>
                                Not at its saved path on this machine — opened the nearest folder:{' '}
                                <span className="font-mono text-text break-all">{note.opened}</span>
                              </>
                            ) : (
                              <>
                                Not on this machine — it was saved as <span className="font-mono text-text break-all">{note.path}</span>
                              </>
                            )}
                          </p>
                          <div className="flex items-center gap-3 flex-wrap">
                            <button onClick={() => void handleRelocateFile(a)} className="g-lnk !px-0 !text-xs">
                              Point to it on this machine…
                            </button>
                            {a.is_shared && (
                              <button onClick={() => void downloadSharedFile(a.id, a.file_name)} className="g-lnk !px-0 !text-xs">
                                Download the shared copy
                              </button>
                            )}
                            <button
                              onClick={() =>
                                setRevealNote((m) => {
                                  const n = { ...m };
                                  delete n[a.id];
                                  return n;
                                })
                              }
                              className="ml-auto g-lnk !text-xs !text-subtext-0"
                            >
                              Dismiss
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                }}
                empty={<p className="text-center py-5 text-subtext-0">No files attached yet</p>}
              />
            </div>
            {canManage && hasDaemon() && (
              <TaskShareLinks taskId={task.id} taskTitle={task.title} files={fileAttachments} />
            )}
          </TaskUploadArea>
        ) : activeTab === 'events' ? (
          <div className="flex flex-col gap-[18px]">
            {/* Use event date as deadline toggle */}
            <div className="g-inset flex items-center gap-3.5">
              <div className="flex-1">
                <p id={`evd-${task.id}`} className="font-semibold text-text">Use event date as deadline</p>
                <p className="text-[13px] text-subtext-0 mt-0.5">
                  When linking, sets the task deadline from the event's date.
                </p>
              </div>
              <button
                onClick={() => setUseEventDeadline(!useEventDeadline)}
                role="switch"
                aria-checked={useEventDeadline}
                aria-labelledby={`evd-${task.id}`}
                className="g-tog"
                title={useEventDeadline ? 'Disable' : 'Enable'}
              >
                <span className="g-tog-k" />
              </button>
            </div>

            {/* Linked Events */}
            {linkedEvents.length > 0 && (
              <div>
                <h3 className="g-flbl">Linked events</h3>
                <div className="border-t border-gilt-b">
                {linkedEvents.map((event) => (
                  <div
                    key={event.id}
                    className="g-frow py-2"
                  >
                    <button
                      onClick={() => onOpenEvent?.(event)}
                      disabled={!onOpenEvent}
                      className={`flex-1 min-w-0 text-left ${onOpenEvent ? 'hover:text-gold cursor-pointer' : 'cursor-default'}`}
                      title={onOpenEvent ? 'Open event' : undefined}
                    >
                      <p className="text-text font-medium truncate">{event.title}</p>
                      <p className="text-xs text-subtext-0 mt-0.5 tabular-nums">
                        {new Date(event.event_date).toLocaleDateString('en-US', {
                          weekday: 'short',
                          month: 'short',
                          day: 'numeric',
                          year: 'numeric',
                        })}
                        {!event.all_day && event.start_time && ` · ${event.start_time}`}
                      </p>
                    </button>
                    <button
                      onClick={() => handleUnlinkEvent(event.id)}
                      className="g-iconbtn !w-8 !h-8 hover:!text-error flex-shrink-0"
                      title="Unlink event"
                      aria-label={`Unlink ${event.title}`}
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M6 18L18 6M6 6l12 12"
                        />
                      </svg>
                    </button>
                  </div>
                ))}
                </div>
              </div>
            )}

            {/* Link an Event */}
            <div>
              <h3 className="g-flbl">Link an event</h3>
              <MultiSelectDropdown
                label="Select events..."
                items={[...projectEvents].sort(
                  (a, b) =>
                    new Date(a.event_date).getTime() - new Date(b.event_date).getTime()
                )}
                selectedIds={linkedEvents.map((e) => e.id)}
                onChange={handleEventSelectionChange}
                getDisplayName={(e) =>
                  `${e.title} — ${new Date(e.event_date).toLocaleDateString('en-US', {
                    month: 'short',
                    day: 'numeric',
                    year: 'numeric',
                  })}`
                }
                searchable
                searchPlaceholder="Search events..."
                emptyMessage="No events linked to this project. Link an event to this project from the calendar first."
              />
            </div>
          </div>
        ) : null}
      </div>

      {/* Footer (narrow panes only — the page layout has Save in its sidebar) */}
      {!page && (
        <div className="flex-shrink-0 px-[22px] py-3.5 border-t border-gilt-a bg-mantle">
          <button
            onClick={handleSave}
            disabled={isSaving || !title.trim()}
            className="g-btn g-btn-pri g-glint w-full min-h-[44px]"
          >
            {isSaving ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      )}

      {/* Description Modal */}
      <TaskDescriptionModal
        task={task}
        isOpen={isDescriptionModalOpen}
        onClose={() => setIsDescriptionModalOpen(false)}
        onSave={(saved) => {
          const updatedTask = task ? rememberSaved(task, saved, beginSave()) : saved;
          prevTaskSnapshot.current = updatedTask;
          onSave(updatedTask);
          setDescription(updatedTask.description || '');
          setIsDescriptionModalOpen(false);
        }}
      />

      {/* Local-file link confirmation: sharing uploads the file to the server
          and makes it visible to everyone with task access. */}
      {shareConfirm && (
        <Modal onClose={() => setShareConfirm(null)} title="Link a local file" className="w-[440px]">
          <div className="px-6 pb-6">
            <h3 className="text-base font-semibold text-text mb-2 break-words">Link “{shareConfirm.option.att.file_name}”?</h3>
            <p className="text-sm text-subtext-1 mb-4">
              This file is on your machine only. Linking it will <span className="text-text font-medium">upload it to the server</span> so the reference resolves for everyone — which makes it available to anyone with access to this task.
            </p>
            <label className="flex items-center gap-2 text-sm text-subtext-1 mb-4 cursor-pointer">
              <input
                type="checkbox"
                checked={shareConfirm.dontShowAgain}
                onChange={(e) => setShareConfirm((s) => (s ? { ...s, dontShowAgain: e.target.checked } : s))}
              />
              Don’t show this warning again
            </label>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setShareConfirm(null)}
                className="g-btn g-btn-ghost"
              >
                Cancel
              </button>
              <button
                onClick={async () => {
                  const { option, slashIdx, pos, dontShowAgain } = shareConfirm;
                  setShareConfirm(null);
                  if (dontShowAgain) setWarnLocalFileLink(false);
                  try {
                    // Share first (uploads to server + flips is_shared), then
                    // refresh the local list so the picker's next open reflects
                    // it, then insert the now-resolvable reference.
                    await shareFileAttachment(option.att.id);
                    await loadFiles();
                    await insertFileOption(option, slashIdx, pos);
                  } catch (err) {
                    alert(`Could not share file: ${err instanceof Error ? err.message : String(err)}`);
                  }
                }}
                className="g-btn g-btn-pri"
              >
                Link &amp; upload
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

/** A small autocomplete that pops up when the user types `/file` in the task
 * description. Renders one row per pickable option: a link row for every file,
 * plus an embed row for images. Keyboard nav (arrows or j/k) moves the active
 * row; Enter selects. Selecting a LOCAL attachment routes through the
 * share-confirm dialog (see TaskEditor.pickOption) before inserting. */
function FileReferencePicker({
  options,
  activeIndex,
  onActiveChange,
  onPick,
  onClose,
}: {
  options: FileOption[];
  activeIndex: number;
  onActiveChange: (i: number) => void;
  onPick: (option: FileOption) => void;
  onClose: () => void;
}) {
  const listRef = useRef<HTMLDivElement | null>(null);
  // Keep the active row visible WITHIN the picker's own scroll container — do
  // NOT use scrollIntoView(), which scrolls the nearest scrollable ancestor
  // (the content area) and pushes the whole panel out of view. Manual
  // scrollTop adjustment touches only the picker's own overflow-y-auto.
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    // child[0] is the sticky header; rows start at child[1].
    const row = list.children[activeIndex + 1] as HTMLElement | undefined;
    if (!row) return;
    const top = row.offsetTop - list.offsetTop;
    const bottom = top + row.offsetHeight;
    if (top < list.scrollTop) list.scrollTop = top;
    else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight;
  }, [activeIndex, options.length]);

  if (options.length === 0) {
    return (
      <div className="absolute z-20 left-4 bottom-2 g-card shadow-lg p-2.5 text-xs text-subtext-0">
        No attachments match.
      </div>
    );
  }
  return (
    <div ref={listRef} className="absolute z-20 left-4 bottom-2 w-72 max-h-60 overflow-y-auto bg-base border border-gilt-a rounded shadow-lg">
      <div className="px-2 py-1 text-[11px] text-subtext-0 border-b border-gilt-b flex items-center justify-between sticky top-0 bg-base z-10">
        <span>Link a file · ↑↓ or j/k · Enter to pick</span>
        <button onClick={onClose} className="text-subtext-0 hover:text-text">✕</button>
      </div>
      {options.map((opt, i) => {
        const isImg = (opt.att.file_type || '').startsWith('image/');
        const active = i === activeIndex;
        return (
          <button
            key={`${opt.att.id}-${opt.mode}`}
            // onMouseMove (not onMouseEnter) so the highlight follows the cursor
            // only when the user is actively moving the mouse — not when
            // keyboard nav lands on a row that happens to be under the cursor.
            onMouseMove={() => { if (i !== activeIndex) onActiveChange(i); }}
            onClick={() => onPick(opt)}
            className={`w-full text-left px-2 py-1.5 flex items-center gap-2 ${active ? 'bg-gilt-b text-gold' : 'hover:bg-surface-0'}`}
          >
            <span className="text-xs shrink-0">{opt.mode === 'embed' ? '🖼️' : isImg ? '🖼️' : '📎'}</span>
            <span className="flex-1 min-w-0 truncate text-sm text-text">{opt.att.file_name}</span>
            {opt.mode === 'embed' && <span className="text-[10px] text-subtext-0 shrink-0">embed</span>}
            {!opt.att.is_shared && <span className="text-[10px] text-warning shrink-0">local</span>}
            {opt.att.is_shared && opt.mode === 'link' && <span className="text-[10px] text-primary shrink-0">shared</span>}
          </button>
        );
      })}
    </div>
  );
}
