import { useState, useEffect } from 'react';
import { updateProject, getProjectStats, getTasks, getFileAttachments, getProjectEvents, setProjectModelProfile, getProjectStorage, setProjectQuota, getAppSetting } from '../lib/api';
import { hasDaemon, listProfiles, listAvailableTabs, getProjectTabs, setProjectTab, setProjectAiFiles, getApprovalPolicy, setApprovalPolicy, getMemberAtlasExport, setMemberAtlasExport, type ModelProfile, type TabDescriptor } from '../lib/daemon';
import type { Project, ProjectStats, Task, Event } from '../types';
import ScrollArea from './ScrollArea';
import { Modal } from './gilt';
import { TabIcon } from './icons/TabIcon';
import { stashTabIcon } from '../tabs/registry';
import { useKnowledgeEngine } from './KnowledgeEngine';

interface ProjectSettingsModalProps {
  project: Project;
  isOpen: boolean;
  onClose: () => void;
  onUpdate: (project: Project) => void;
}

export default function ProjectSettingsModal({
  project,
  isOpen,
  onClose,
  onUpdate,
}: ProjectSettingsModalProps) {
  const [projectName, setProjectName] = useState(project.name);
  const [projectDescription, setProjectDescription] = useState(project.description || '');
  const [isSaving, setIsSaving] = useState(false);
  const [stats, setStats] = useState<ProjectStats | null>(null);
  const [isLoadingStats, setIsLoadingStats] = useState(false);
  const [linkedEvents, setLinkedEvents] = useState<Event[]>([]);
  const [isLoadingEvents, setIsLoadingEvents] = useState(false);
  const [profiles, setProfiles] = useState<ModelProfile[]>([]);
  const [profileId, setProfileId] = useState<number | null>(project.model_profile_id ?? null);
  const [approvalPol, setApprovalPol] = useState<'proposer' | 'owner'>('proposer');
  const [approvalMsg, setApprovalMsg] = useState<string | null>(null);
  const [atlasExport, setAtlasExport] = useState(false);
  const [availableTabs, setAvailableTabs] = useState<TabDescriptor[]>([]);
  const [enabledTabs, setEnabledTabs] = useState<string[]>([]);
  const [storageUsed, setStorageUsed] = useState<number | null>(null);
  const [quotaMb, setQuotaMb] = useState('');
  const [quotaMsg, setQuotaMsg] = useState<string | null>(null);
  const [aiFiles, setAiFiles] = useState(false); // default OFF (privacy-first); opt-in
  const [aiFilesMsg, setAiFilesMsg] = useState<string | null>(null);

  // Load project statistics
  useEffect(() => {
    if (isOpen) {
      loadStats();
      loadLinkedEvents();
      setProfileId(project.model_profile_id ?? null);
      if (hasDaemon()) {
        listProfiles()
          .then((r) => setProfiles(r.profiles))
          .catch(() => setProfiles([]));
        listAvailableTabs().then(setAvailableTabs).catch(() => setAvailableTabs([]));
        getProjectTabs(project.id).then(setEnabledTabs).catch(() => setEnabledTabs([]));
        getApprovalPolicy(project.id)
          .then((r) => setApprovalPol(r.policy))
          .catch(() => setApprovalPol('proposer'));
        getMemberAtlasExport(project.id).then(setAtlasExport).catch(() => setAtlasExport(false));
      }
      getProjectStorage(project.id)
        .then((s) => {
          setStorageUsed(s.used);
          setQuotaMb(s.quota > 0 ? String(Math.round(s.quota / (1024 * 1024))) : '');
        })
        .catch(() => setStorageUsed(null));
      getAppSetting(`rag_files_enabled_${project.id}`)
        .then((v) => setAiFiles(v === '1'))
        .catch(() => setAiFiles(false));
      setQuotaMsg(null);
      setAiFilesMsg(null);
    }
  }, [isOpen, project.id]);

  const saveQuota = async () => {
    const mb = Math.max(0, Number(quotaMb) || 0);
    try {
      await setProjectQuota(project.id, Math.round(mb * 1024 * 1024));
      setQuotaMsg(mb > 0 ? `Limit set to ${mb} MB.` : 'Limit removed (unlimited).');
    } catch (e) {
      setQuotaMsg(e instanceof Error ? e.message : String(e));
    }
  };

  // false = no knowledge engine on the host: the switch is kept, and says it waits for one.
  const engine = useKnowledgeEngine();

  const toggleAiFiles = async (on: boolean) => {
    setAiFiles(on);
    try {
      const r = await setProjectAiFiles(project.id, on);
      if (engine === false) {
        setAiFilesMsg(on ? 'AI access allowed.' : 'AI access disabled.');
      } else if (on) {
        setAiFilesMsg("AI can read and index this project's files again — the next indexing cycle rebuilds the index.");
      } else {
        const freed = r.freed?.freed_bytes;
        setAiFilesMsg(
          freed != null
            ? `AI access disabled. Index deleted — freed ${(freed / (1024 * 1024)).toFixed(1)} MB (${r.freed?.doc_count ?? '?'} docs, ${r.freed?.chunk_count ?? '?'} chunks).`
            : 'AI access disabled: indexing stops and chat/agents stop reading these files. (Engine unreachable — the index will be removed when it is back and the toggle is flipped again.)'
        );
      }
    } catch (e) {
      setAiFiles(!on); // roll back
      setAiFilesMsg(e instanceof Error ? e.message : String(e));
    }
  };

  const toggleTab = async (tabId: string, enabled: boolean) => {
    const prev = enabledTabs;
    setEnabledTabs(enabled ? [...prev, tabId] : prev.filter((t) => t !== tabId));
    try {
      await setProjectTab(project.id, tabId, enabled);
    } catch (error) {
      setEnabledTabs(prev); // roll back on failure (e.g. not a project admin)
      console.error('Failed to toggle tab:', error);
      alert('Could not change tabs — only project admins can.');
    }
  };

  const changeProfile = async (id: number | null) => {
    setProfileId(id);
    try {
      await setProjectModelProfile(project.id, id);
      onUpdate({ ...project, model_profile_id: id });
    } catch (error) {
      console.error('Failed to set project assistant:', error);
      alert('Failed to set project assistant');
    }
  };

  const loadLinkedEvents = async () => {
    setIsLoadingEvents(true);
    try {
      const events = await getProjectEvents(project.id, false);
      setLinkedEvents(events);
    } catch (error) {
      console.error('Failed to load linked events:', error);
    } finally {
      setIsLoadingEvents(false);
    }
  };

  // Handle Escape key
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        onClose();
      }
    };

    if (isOpen) {
      window.addEventListener('keydown', handleEscape);
      return () => window.removeEventListener('keydown', handleEscape);
    }
  }, [isOpen, onClose]);

  // Reset form when project changes
  useEffect(() => {
    setProjectName(project.name);
    setProjectDescription(project.description || '');
  }, [project]);

  const loadStats = async () => {
    setIsLoadingStats(true);
    try {
      // Get project stats from backend
      const projectStats = await getProjectStats(project.id);
      setStats(projectStats);
    } catch (error) {
      console.error('Failed to load project stats:', error);
      // Fallback: Calculate stats manually
      try {
        const tasks = await getTasks(project.id, false);
        const filePromises = tasks.map(task => getFileAttachments(task.id));
        const fileArrays = await Promise.all(filePromises);
        const totalFiles = fileArrays.flat().length;

        const tasksByStatus = {
          todo: tasks.filter((t: Task) => t.status === 'To Do').length,
          in_progress: tasks.filter((t: Task) => t.status === 'In Progress').length,
          done: tasks.filter((t: Task) => t.status === 'Done').length,
          blocked: tasks.filter((t: Task) => t.status === 'Blocked').length,
        };

        const totalCost = tasks.reduce((sum: number, t: Task) => sum + (t.cost || 0), 0);

        setStats({
          total_tasks: tasks.length,
          tasks_by_status: tasksByStatus,
          total_time_seconds: 0, // Will be calculated by backend
          total_files: totalFiles,
          total_cost: totalCost,
        });
      } catch (fallbackError) {
        console.error('Failed to calculate fallback stats:', fallbackError);
      }
    } finally {
      setIsLoadingStats(false);
    }
  };

  const handleSave = async () => {
    if (!projectName.trim()) {
      alert('Project name cannot be empty');
      return;
    }

    setIsSaving(true);
    try {
      const updatedProject = await updateProject(project.id, {
        name: projectName,
        description: projectDescription || undefined,
      });
      onUpdate(updatedProject);
      onClose();
    } catch (error) {
      console.error('Failed to update project:', error);
      alert(`Failed to update project: ${error}`);
    } finally {
      setIsSaving(false);
    }
  };

  const formatTime = (seconds: number): string => {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (hours > 0) {
      return `${hours}h ${minutes}m`;
    }
    return `${minutes}m`;
  };

  const formatCurrency = (amount: number): string => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
    }).format(amount);
  };

  if (!isOpen) return null;

  return (
    <Modal onClose={onClose} closeOnScrim={false} className="w-[min(1280px,92vw)] h-[85vh] !flex-row">
        {/* Left Sidebar - Statistics */}
        <ScrollArea className="w-1/3 min-w-[260px] max-w-[420px] shrink-0 bg-mantle border-r border-gilt-b" contentClassName="p-6">
          <h2 className="g-h2">Project Statistics</h2>

          {isLoadingStats ? (
            <div className="flex items-center justify-center h-32">
              <p className="text-subtext-0">Loading statistics...</p>
            </div>
          ) : stats ? (
            <div className="space-y-6">
              {/* Total Tasks */}
              <div className="g-card px-5 py-4">
                <h3 className="g-deco text-[11px] font-semibold text-[color:var(--g-mut)] mb-2">Total Tasks</h3>
                <p className="font-deco font-light text-[38px] leading-[1.1] text-text tabular-nums">{stats.total_tasks}</p>
              </div>

              {/* Tasks by Status */}
              <div className="g-card px-5 py-4">
                <h3 className="g-deco text-[11px] font-semibold text-[color:var(--g-mut)] mb-3">Tasks by Status</h3>
                <div className="space-y-2">
                  <div className="flex justify-between items-center">
                    <span className="inline-flex items-center gap-2 text-sm text-text"><span className="g-st" aria-hidden="true" />To Do</span>
                    <span className="text-sm font-medium text-text tabular-nums">{stats.tasks_by_status.todo}</span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="inline-flex items-center gap-2 text-sm text-text"><span className="g-st g-st-progress" aria-hidden="true" />In Progress</span>
                    <span className="text-sm font-medium text-text tabular-nums">{stats.tasks_by_status.in_progress}</span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="inline-flex items-center gap-2 text-sm text-text"><span className="g-st g-st-done" aria-hidden="true" />Done</span>
                    <span className="text-sm font-medium text-text tabular-nums">{stats.tasks_by_status.done}</span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="inline-flex items-center gap-2 text-sm text-text"><span className="g-st g-st-blocked" aria-hidden="true" />Blocked</span>
                    <span className="text-sm font-medium text-text tabular-nums">{stats.tasks_by_status.blocked}</span>
                  </div>
                </div>
              </div>

              {/* Time Spent */}
              <div className="g-card px-5 py-4">
                <h3 className="g-deco text-[11px] font-semibold text-[color:var(--g-mut)] mb-2">Time Spent</h3>
                <p className="font-deco font-light text-3xl leading-[1.1] text-text tabular-nums">{formatTime(stats.total_time_seconds)}</p>
              </div>

              {/* Number of Files */}
              <div className="g-card px-5 py-4">
                <h3 className="g-deco text-[11px] font-semibold text-[color:var(--g-mut)] mb-2">Attached Files</h3>
                <p className="font-deco font-light text-3xl leading-[1.1] text-text tabular-nums">{stats.total_files}</p>
              </div>

              {/* Total Cost */}
              <div className="g-card px-5 py-4">
                <h3 className="g-deco text-[11px] font-semibold text-[color:var(--g-mut)] mb-2">Total Cost</h3>
                <p className="font-deco font-light text-3xl leading-[1.1] text-text tabular-nums">{formatCurrency(stats.total_cost)}</p>
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-center h-32">
              <p className="text-subtext-0">No statistics available</p>
            </div>
          )}
        </ScrollArea>

        {/* Right Side - Settings */}
        <div className="flex-1 min-w-0 flex flex-col">
          {/* Header */}
          <div className="relative px-6 pt-6 pb-4 border-b border-gilt-b flex items-center justify-center">
            <h2 className="g-h2 !mb-0">Project Settings</h2>
            <button
              onClick={onClose}
              className="g-iconbtn absolute right-4 top-4"
              title="Close (Esc)"
              aria-label="Close"
            >
              <svg
                className="w-5 h-5"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M6 18L18 6M6 6l12 12"
                />
              </svg>
            </button>
          </div>

          {/* Content */}
          <ScrollArea className="flex-1 min-h-0" contentClassName="p-6">
            <div className="max-w-2xl mx-auto space-y-6">
              {/* Project Name */}
              <div>
                <label className="block g-deco text-[11px] font-semibold text-gold mb-2">
                  Project Name
                </label>
                <input
                  type="text"
                  value={projectName}
                  onChange={(e) => setProjectName(e.target.value)}
                  className="g-field"
                  placeholder="Enter project name..."
                />
              </div>

              {/* Project Description */}
              <div>
                <label className="block g-deco text-[11px] font-semibold text-gold mb-2">
                  Description (Optional)
                </label>
                <textarea
                  value={projectDescription}
                  onChange={(e) => setProjectDescription(e.target.value)}
                  rows={4}
                  className="g-field resize-none"
                  placeholder="Enter project description..."
                />
              </div>

              {/* Files & AI: storage ceiling + the AI-access switch */}
              <div>
                <label className="block g-deco text-[11px] font-semibold text-gold mb-2">Files & AI</label>
                <div className="space-y-2">
                  <div className="g-plain p-3 space-y-2">
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-sm text-text">Shared-files storage limit</span>
                      {storageUsed != null && (
                        <span className="text-xs text-subtext-0">{(storageUsed / (1024 * 1024)).toFixed(1)} MB used</span>
                      )}
                    </div>
                    <div className="flex gap-2">
                      <input
                        type="number"
                        min={0}
                        value={quotaMb}
                        onChange={(e) => setQuotaMb(e.target.value)}
                        placeholder="Unlimited"
                        className="g-field flex-1"
                      />
                      <span className="self-center text-xs text-subtext-0">MB</span>
                      <button onClick={() => void saveQuota()} className="g-btn g-btn-pri g-btn-sm">
                        Save
                      </button>
                    </div>
                    {quotaMsg && <p className="text-xs text-subtext-1">{quotaMsg}</p>}
                  </div>

                  <label className="flex items-start gap-3 g-plain p-3 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={aiFiles}
                      onChange={(e) => void toggleAiFiles(e.target.checked)}
                      className="mt-0.5"
                    />
                    <span className="min-w-0">
                      <span className="text-sm text-text">Allow AI access to files</span>
                      <span className="block text-xs text-subtext-0">
                        When off, this project's files are never indexed and the assistant, agents and secretary
                        cannot search or quote them.
                        {engine === false && ' Takes effect once the knowledge engine is set up.'}
                      </span>
                    </span>
                  </label>
                  {aiFilesMsg && <p className="text-xs text-subtext-1">{aiFilesMsg}</p>}
                </div>
              </div>

              {/* Stash tabs (per-project panels + optional agent tools) */}
              {hasDaemon() && (
                <div>
                  <label className="block g-deco text-[11px] font-semibold text-gold mb-2">Tabs</label>
                  {availableTabs.length === 0 ? (
                    <p className="text-xs text-subtext-0">
                      No tabs reported by the host — if you just updated Ganban, restart the app so the embedded server picks them up.
                    </p>
                  ) : (
                    <div className="space-y-2">
                      {availableTabs.map((t) => (
                        <label
                          key={t.id}
                          className="flex items-start gap-3 g-plain p-3 cursor-pointer"
                        >
                          <input
                            type="checkbox"
                            checked={enabledTabs.includes(t.id)}
                            onChange={(e) => toggleTab(t.id, e.target.checked)}
                            className="mt-0.5"
                          />
                          <span className="min-w-0">
                            <span className="text-sm text-text">
                              <TabIcon name={stashTabIcon(t)} className="inline-block align-middle -mt-0.5 mr-1.5 w-4 h-4 text-subtext-0" />
                              {t.name}
                              {t.has_tools && <span className="ml-2 g-tag !min-h-[20px] !px-2 !text-[10px]">agent tools</span>}
                            </span>
                            <span className="block text-xs text-subtext-0">{t.description}</span>
                          </span>
                        </label>
                      ))}
                    </div>
                  )}
                  <p className="text-xs text-subtext-0 mt-1">
                    Enabled tabs appear in this project's tab bar (also togglable from the ＋ at the end of the bar). Tabs marked “agent tools” extend what the assistant can do here — writes still need your approval.
                  </p>
                </div>
              )}

              {/* Project assistant (model personality) */}
              {hasDaemon() && (
                <div>
                  <label className="block g-deco text-[11px] font-semibold text-gold mb-2">Project assistant</label>
                  <select
                    value={profileId ?? ''}
                    onChange={(e) => changeProfile(e.target.value ? Number(e.target.value) : null)}
                    className="g-field"
                  >
                    <option value="">Default (globally active personality)</option>
                    {profiles.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}{p.model ? ` · ${p.model}` : ''}
                      </option>
                    ))}
                  </select>
                  <p className="text-xs text-subtext-0 mt-1">
                    Chats in this project use this personality automatically — no need to switch the active one in Settings.
                  </p>
                </div>
              )}

              {/* Approval policy: who resolves this project's agent proposals */}
              {hasDaemon() && (
                <div>
                  <label className="block g-deco text-[11px] font-semibold text-gold mb-2">Agent approval policy</label>
                  <select
                    value={approvalPol}
                    onChange={async (e) => {
                      const p = e.target.value as 'proposer' | 'owner';
                      setApprovalPol(p);
                      setApprovalMsg(null);
                      try { await setApprovalPolicy(project.id, p); }
                      catch (err) { setApprovalMsg(err instanceof Error ? err.message : String(err)); }
                    }}
                    className="g-field"
                  >
                    <option value="proposer">Each member approves their own agent's proposals (default)</option>
                    <option value="owner">The owner approves all agent proposals</option>
                  </select>
                  <p className="text-xs text-subtext-0 mt-1">
                    Agent writes never apply directly — this picks who reviews them. Both identities (proposer + approver) always land on the activity ledger.
                  </p>
                  {approvalMsg && <p className="text-xs text-error mt-1">{approvalMsg}</p>}
                  <label className="flex items-start gap-2 mt-3 text-sm text-text cursor-pointer">
                    <input
                      type="checkbox"
                      checked={atlasExport}
                      onChange={async (e) => {
                        const v = e.target.checked;
                        setAtlasExport(v);
                        try { await setMemberAtlasExport(project.id, v); }
                        catch (err) { setAtlasExport(!v); setApprovalMsg(err instanceof Error ? err.message : String(err)); }
                      }}
                      className="mt-0.5"
                    />
                    <span>
                      Members may copy this project's files into <em>their own</em> Atlas
                      <span className="block text-xs text-subtext-0">
                        Lets a member's local agents reference the documents a work brief points at — the copy lands in
                        their library, on their machine, and indexing stays their call. (Members can already download
                        files; this sanctions the in-app flow.)
                      </span>
                    </span>
                  </label>
                </div>
              )}

              {/* Linked Events */}
              <div className="g-card px-5 py-4">
                <h3 className="g-deco text-[11px] font-semibold text-[color:var(--g-mut)] mb-3">
                  Linked Events {linkedEvents.length > 0 && `(${linkedEvents.length})`}
                </h3>
                {isLoadingEvents ? (
                  <p className="text-sm text-subtext-0">Loading events...</p>
                ) : linkedEvents.length === 0 ? (
                  <p className="text-sm text-subtext-0">
                    No events linked to this project. Link events from the calendar's event details panel.
                  </p>
                ) : (
                  <div className="space-y-2 max-h-64 overflow-y-auto">
                    {linkedEvents.map((event) => (
                      <div key={event.id} className="g-plain p-3">
                        <div className="flex items-start justify-between gap-2">
                          <p className="text-sm font-medium text-text truncate flex-1">{event.title}</p>
                          <span className="text-xs text-subtext-0 flex-shrink-0">
                            {new Date(event.event_date).toLocaleDateString('en-US', {
                              month: 'short',
                              day: 'numeric',
                              year: 'numeric',
                            })}
                          </span>
                        </div>
                        {!event.all_day && event.start_time && (
                          <p className="text-xs text-subtext-0 mt-1">
                            {event.start_time}
                            {event.end_time && ` – ${event.end_time}`}
                          </p>
                        )}
                        {event.location && (
                          <p className="text-xs text-subtext-0 mt-1 truncate">{event.location}</p>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Project Info */}
              <div className="g-card px-5 py-4">
                <h3 className="g-deco text-[11px] font-semibold text-[color:var(--g-mut)] mb-3">Project Information</h3>
                <div className="space-y-2 text-sm">
                  <div className="flex justify-between">
                    <span className="text-subtext-0">Created:</span>
                    <span className="text-text">
                      {new Date(project.created_at).toLocaleDateString()}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-subtext-0">Last Updated:</span>
                    <span className="text-text">
                      {new Date(project.updated_at).toLocaleDateString()}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-subtext-0">Status:</span>
                    <span className="text-text">
                      {project.archived ? 'Archived' : 'Active'}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-subtext-0">Pinned:</span>
                    <span className="text-text">
                      {project.pinned ? 'Yes' : 'No'}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </ScrollArea>

          {/* Footer */}
          <div className="px-6 py-4 border-t border-gilt-b flex justify-end gap-3">
            <button
              onClick={onClose}
              className="g-btn g-btn-ghost"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={isSaving || !projectName.trim()}
              className="g-btn g-btn-pri"
            >
              {isSaving ? 'Saving...' : 'Save Changes'}
            </button>
          </div>
        </div>
    </Modal>
  );
}
