import { useState, useEffect } from 'react';
import { confirmDialog } from '../lib/confirm';
import ScrollArea from './ScrollArea';
import { TabIcon, type TabIconName } from './icons/TabIcon';
import { getContacts, restoreContact, permanentlyDeleteContact } from '../lib/api';
import { getWorkspace, listWorkspaces, LOCAL_ID } from '../lib/workspaces';
import {
  wsGetTasks, wsGetEvents,
  wsRestoreTask, wsPermanentlyDeleteTask,
  wsRestoreEvent, wsPermanentlyDeleteEvent,
  wsArchiveProject, wsDeleteProject,
} from '../lib/workspaceData';
import { useAppStore } from '../store/appStore';
import type { Task, Event, Contact, Project } from '../types';
import TaskEditor from './TaskEditor';
import EventEditor from './EventEditor';
import ContactEditor from './ContactEditor';
import { projectColorClass, projectInitial } from '../lib/projectColor';

const MUTED = 'text-[color:var(--g-mut)]';
/** Bin lists run in columns on a wide window. */
const LIST_GRID = 'grid gap-4 grid-cols-[repeat(auto-fill,minmax(min(100%,440px),1fr))]';
const CARD = 'g-card p-5 min-w-0 transition-colors';
const RESTORE = 'g-btn g-btn-gilt g-btn-sm';
const FOREVER = 'g-btn g-btn-danger g-btn-sm';

type BinTab = 'tasks' | 'events' | 'contacts' | 'projects';

export default function BinView() {
  const { projects, selectedTask, selectTask, updateProject, removeProject } = useAppStore();
  const [activeTab, setActiveTab] = useState<BinTab>('tasks');
  const [deletedTasks, setDeletedTasks] = useState<Task[]>([]);
  const [deletedEvents, setDeletedEvents] = useState<Event[]>([]);
  const [deletedContacts, setDeletedContacts] = useState<Contact[]>([]);
  const [selectedEvent, setSelectedEvent] = useState<Event | null>(null);
  const [selectedContact, setSelectedContact] = useState<Contact | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  // K2: the Bin spans every workspace. Resolve each item's OWN host so restore/
  // delete can't hit a colliding id on the wrong workspace, and key the lists by
  // (workspace,id) composites.
  const wsOf = (item: { workspaceId?: string }) => getWorkspace(item.workspaceId ?? LOCAL_ID);
  const evKey = (e: Event) => `${e.workspaceId ?? LOCAL_ID}:${e.id}`;
  const tkKey = (t: Task) => `${t.workspaceId ?? LOCAL_ID}:${t.id}`;

  useEffect(() => {
    loadDeleted();
  }, [projects, activeTab]);

  const loadDeleted = async () => {
    setIsLoading(true);
    try {
      if (activeTab === 'tasks') {
        // Archived tasks, fetched from EACH project's own host (so a remote
        // project's bin tasks come from that host, not the active transport).
        const tasksArrays = await Promise.all(
          projects.map((p) => {
            const ws = getWorkspace(p.workspaceId ?? LOCAL_ID);
            return ws ? wsGetTasks(ws, p.id, true).catch(() => [] as Task[]) : Promise.resolve([] as Task[]);
          })
        );
        setDeletedTasks(tasksArrays.flat().filter((t) => t.archived));
      } else if (activeTab === 'events') {
        // Archived events aggregated across every workspace (tagged per host).
        const wss = listWorkspaces().filter((w) => w.id === LOCAL_ID || w.url);
        const arrays = await Promise.all(wss.map((ws) => wsGetEvents(ws, true).catch(() => [] as Event[])));
        setDeletedEvents(arrays.flat());
      } else if (activeTab === 'contacts') {
        // Contacts are a single-host concept (the active host's address book).
        const contacts = await getContacts(true);
        setDeletedContacts(contacts);
      }
      // 'projects' is derived from the store (archived projects) — no fetch.
    } catch (error) {
      console.error('Failed to load deleted items:', error);
    } finally {
      setIsLoading(false);
    }
  };

  // Task handlers — routed to the task's own host (K2).
  const handleRestoreTask = async (task: Task) => {
    const ws = wsOf(task);
    if (!ws) return;
    try {
      await wsRestoreTask(ws, task.id);
      loadDeleted();
    } catch (error) {
      console.error('Failed to restore task:', error);
      alert('Failed to restore task');
    }
  };

  const handlePermanentDeleteTask = async (task: Task) => {
    const ws = wsOf(task);
    if (!ws) return;
    try {
      await wsPermanentlyDeleteTask(ws, task.id);
      loadDeleted();
      if (selectedTask && tkKey(selectedTask) === tkKey(task)) {
        selectTask(null);
      }
    } catch (error) {
      console.error('Failed to permanently delete task:', error);
      alert('Failed to permanently delete task');
    }
  };

  const handleTaskSave = () => {
    // For deleted tasks, we don't allow editing
    console.log('Cannot edit deleted task. Please restore it first.');
  };

  const handleTaskDelete = async () => {
    if (!selectedTask) return;
    await handlePermanentDeleteTask(selectedTask);
  };

  // Event handlers — routed to the event's own host (K2).
  const handleRestoreEvent = async (event: Event) => {
    const ws = wsOf(event);
    if (!ws) return;
    try {
      await wsRestoreEvent(ws, event.id);
      loadDeleted();
      if (selectedEvent && evKey(selectedEvent) === evKey(event)) {
        setSelectedEvent(null);
      }
    } catch (error) {
      console.error('Failed to restore event:', error);
      alert('Failed to restore event');
    }
  };

  const handlePermanentDeleteEvent = async (event: Event) => {
    const ws = wsOf(event);
    if (!ws) return;
    try {
      await wsPermanentlyDeleteEvent(ws, event.id);
      loadDeleted();
      if (selectedEvent && evKey(selectedEvent) === evKey(event)) {
        setSelectedEvent(null);
      }
    } catch (error) {
      console.error('Failed to permanently delete event:', error);
      alert('Failed to permanently delete event');
    }
  };

  const handleEventSave = () => {
    // For deleted events, we don't allow editing
    console.log('Cannot edit deleted event. Please restore it first.');
  };

  const handleEventDelete = async () => {
    if (!selectedEvent) return;
    await handlePermanentDeleteEvent(selectedEvent);
  };

  // Contact handlers
  const handleRestoreContact = async (contactId: number) => {
    try {
      await restoreContact(contactId);
      loadDeleted();
      if (selectedContact?.id === contactId) {
        setSelectedContact(null);
      }
    } catch (error) {
      console.error('Failed to restore contact:', error);
      alert('Failed to restore contact');
    }
  };

  const handlePermanentDeleteContact = async (contactId: number) => {
    try {
      await permanentlyDeleteContact(contactId);
      loadDeleted();
      if (selectedContact?.id === contactId) {
        setSelectedContact(null);
      }
    } catch (error) {
      console.error('Failed to permanently delete contact:', error);
      alert('Failed to permanently delete contact');
    }
  };

  const handleContactSave = () => {
    // For deleted contacts, we don't allow editing
    console.log('Cannot edit deleted contact. Please restore it first.');
  };

  const handleContactDelete = async () => {
    if (!selectedContact) return;
    await handlePermanentDeleteContact(selectedContact.id);
  };

  // Project handlers (archived projects — restore = unarchive). Routed to the
  // project's own host (K2).
  const handleRestoreProject = async (project: Project) => {
    const ws = wsOf(project);
    if (!ws) return;
    try {
      const updated = await wsArchiveProject(ws, project.id, false);
      updateProject({ ...updated, workspaceId: ws.id });
    } catch (error) {
      console.error('Failed to restore project:', error);
      alert('Failed to restore project');
    }
  };

  const handlePermanentDeleteProject = async (project: Project) => {
    if (!await confirmDialog(`Permanently delete "${project.name}" and all of its tasks, areas, files, chats, and event links? This cannot be undone.`)) return;
    const ws = wsOf(project);
    if (!ws) return;
    try {
      await wsDeleteProject(ws, project.id);
      removeProject(project);
    } catch (error) {
      console.error('Failed to permanently delete project:', error);
      alert('Failed to permanently delete project');
    }
  };

  const archivedProjects = projects.filter((p) => p.archived);

  // Match by (workspace, id) — ids collide across hosts in the merged view.
  const getProjectName = (task: Task): string => {
    const project = projects.find(
      (p) => p.id === task.project_id && (p.workspaceId ?? LOCAL_ID) === (task.workspaceId ?? LOCAL_ID)
    );
    return project?.name || 'Unknown Project';
  };
  const projectGem = (task: Task): string => {
    const project = projects.find(
      (p) => p.id === task.project_id && (p.workspaceId ?? LOCAL_ID) === (task.workspaceId ?? LOCAL_ID)
    );
    return project ? projectColorClass(project) : 'c-none';
  };

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  };

  return (
    <div className="flex h-full">
      <div className="flex-1 min-w-0 flex flex-col bg-mantle">
        {(() => {
          const TABS: { id: BinTab; label: string; icon: TabIconName; count: number }[] = [
            { id: 'tasks', label: 'Tasks', icon: 'tasks', count: deletedTasks.length },
            { id: 'events', label: 'Events', icon: 'events', count: deletedEvents.length },
            { id: 'contacts', label: 'Contacts', icon: 'members', count: deletedContacts.length },
            { id: 'projects', label: 'Projects', icon: 'files', count: archivedProjects.length },
          ];
          const activeCount = TABS.find((t) => t.id === activeTab)?.count ?? 0;
          const switchTab = (id: BinTab) => {
            setActiveTab(id);
            selectTask(null);
            setSelectedEvent(null);
            setSelectedContact(null);
          };
          return (
            <>
              {/* Header (no bottom border — the tab bar below owns the single divider) */}
              <div className="px-8 pt-[30px] pb-5 flex items-end justify-between gap-4 flex-wrap">
                <div className="min-w-0">
                  <div className="g-deco text-xs text-gold">
                    {activeCount} item{activeCount !== 1 ? 's' : ''}
                  </div>
                  <h1 className="g-ptitle text-text">Bin</h1>
                  <p className={`text-sm mt-2 ${MUTED}`}>
                    Deleted and archived items are kept here. Restore them or delete permanently.
                  </p>
                </div>
              </div>

              {/* Tabs — underline chrome matching Projects / Calendar / Assistant */}
              <nav className="flex items-center flex-wrap gap-0.5 px-6 border-y border-gilt-b bg-mantle">
                {TABS.map((t) => (
                  <button
                    key={t.id}
                    onClick={() => switchTab(t.id)}
                    aria-current={activeTab === t.id ? 'page' : undefined}
                    className={`min-h-[42px] px-4 inline-flex items-center whitespace-nowrap text-sm font-medium transition-colors ${
                      activeTab === t.id
                        ? 'text-gold shadow-[inset_0_-2px_0_var(--color-gold)]'
                        : 'text-[color:var(--g-fg2)] hover:text-text'
                    }`}
                  >
                    <TabIcon name={t.icon} className="w-4 h-4 mr-2" />
                    {t.label}&nbsp;<span className={`tabular-nums ${MUTED}`}>({t.count})</span>
                  </button>
                ))}
              </nav>
            </>
          );
        })()}

        {/* Content */}
        <ScrollArea className="flex-1 min-h-0" contentClassName="px-8 pt-6 pb-16">
          {isLoading ? (
            <div className="flex items-center justify-center h-full">
              <p className={MUTED}>Loading...</p>
            </div>
          ) : activeTab === 'tasks' ? (
            /* Tasks Tab */
            deletedTasks.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full text-center">
                <svg className="w-16 h-16 text-gilt-a mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4" />
                </svg>
                <p className="g-deco text-[15px] text-text mb-2">No Deleted Tasks</p>
                <p className={MUTED}>Deleted tasks will appear here</p>
              </div>
            ) : (
              <div className={LIST_GRID}>
                {deletedTasks.map((task) => (
                  <div
                    key={tkKey(task)}
                    onClick={() => selectTask(task)}
                    className={`${CARD} cursor-pointer ${
                      selectedTask && tkKey(selectedTask) === tkKey(task) ? '!border-gold' : 'hover:border-gold/55'
                    }`}
                  >
                    <div className="flex items-start justify-between">
                      <div className="flex-1 min-w-0">
                        <div className={`text-xs mb-1 flex items-center gap-2 ${MUTED} ${projectGem(task)}`}>
                          <span className="g-gem !w-[7px] !h-[7px]" aria-hidden="true" />
                          {getProjectName(task)}
                        </div>
                        <h3 className="font-semibold text-text mb-1">
                          {task.prefix && <span className="text-gold mr-1">[{task.prefix}]</span>}
                          {task.title}
                        </h3>
                        {task.description && (
                          <p className="text-sm text-[color:var(--g-fg2)] line-clamp-2 mb-2">{task.description}</p>
                        )}
                        <div className={`flex items-center flex-wrap gap-2 text-xs ${MUTED}`}>
                          <span>Deleted: {new Date(task.updated_at).toLocaleDateString()}</span>
                          <span className="g-tag">{task.status}</span>
                          <span className="g-tag">{task.priority}</span>
                        </div>
                      </div>

                      <div className="flex flex-wrap justify-end gap-2 ml-4 shrink-0" onClick={(e) => e.stopPropagation()}>
                        <button
                          onClick={() => handleRestoreTask(task)}
                          className={RESTORE}
                          title="Restore task"
                        >
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                          </svg>
                          Restore
                        </button>
                        <button
                          onClick={() => handlePermanentDeleteTask(task)}
                          className={FOREVER}
                          title="Delete permanently"
                        >
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                          </svg>
                          Delete Forever
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )
          ) : activeTab === 'events' ? (
            /* Events Tab */
            deletedEvents.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full text-center">
                <svg className="w-16 h-16 text-gilt-a mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4" />
                </svg>
                <p className="g-deco text-[15px] text-text mb-2">No Deleted Events</p>
                <p className={MUTED}>Deleted events will appear here</p>
              </div>
            ) : (
              <div className={LIST_GRID}>
                {deletedEvents.map((event) => (
                  <div
                    key={evKey(event)}
                    onClick={() => setSelectedEvent(event)}
                    className={`${CARD} cursor-pointer ${
                      selectedEvent && evKey(selectedEvent) === evKey(event) ? '!border-gold' : 'hover:border-gold/55'
                    }`}
                  >
                    <div className="flex items-start justify-between">
                      <div className="flex-1 min-w-0">
                        <div className={`text-xs mb-1 flex items-center gap-2 ${MUTED}`}>
                          <svg className="w-4 h-4" aria-hidden="true" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                          </svg>
                          {formatDate(event.event_date)}
                        </div>
                        <h3 className="font-semibold text-text mb-1">{event.title}</h3>
                        {event.location && (
                          <p className={`text-sm mb-1 ${MUTED}`}>📍 {event.location}</p>
                        )}
                        {event.description && (
                          <p className="text-sm text-[color:var(--g-fg2)] line-clamp-2 mb-2">{event.description}</p>
                        )}
                        <div className={`flex items-center gap-2 text-xs ${MUTED}`}>
                          <span>Deleted: {new Date(event.updated_at).toLocaleDateString()}</span>
                        </div>
                      </div>

                      <div className="flex flex-wrap justify-end gap-2 ml-4 shrink-0" onClick={(e) => e.stopPropagation()}>
                        <button
                          onClick={() => handleRestoreEvent(event)}
                          className={RESTORE}
                          title="Restore event"
                        >
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                          </svg>
                          Restore
                        </button>
                        <button
                          onClick={() => handlePermanentDeleteEvent(event)}
                          className={FOREVER}
                          title="Delete permanently"
                        >
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                          </svg>
                          Delete Forever
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )
          ) : activeTab === 'contacts' ? (
            /* Contacts Tab */
            deletedContacts.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full text-center">
                <svg className="w-16 h-16 text-gilt-a mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
                </svg>
                <p className="g-deco text-[15px] text-text mb-2">No Deleted Contacts</p>
                <p className={MUTED}>Deleted contacts will appear here</p>
              </div>
            ) : (
              <div className={LIST_GRID}>
                {deletedContacts.map((contact) => {
                  const phones = contact.phone_numbers ? JSON.parse(contact.phone_numbers) : [];
                  const emails = contact.emails ? JSON.parse(contact.emails) : [];

                  return (
                    <div
                      key={contact.id}
                      onClick={() => setSelectedContact(contact)}
                      className={`${CARD} cursor-pointer ${
                        selectedContact?.id === contact.id ? '!border-gold' : 'hover:border-gold/55'
                      }`}
                    >
                      <div className="flex items-start justify-between">
                        <div className="flex-1 min-w-0">
                          <h3 className="font-semibold text-text mb-1">{contact.full_name}</h3>
                          {contact.occupation && (
                            <p className={`text-sm mb-1 ${MUTED}`}>{contact.occupation}</p>
                          )}
                          {phones.length > 0 && (
                            <p className="text-sm text-[color:var(--g-fg2)]">📞 {phones[0]}</p>
                          )}
                          {emails.length > 0 && (
                            <p className="text-sm text-[color:var(--g-fg2)]">✉️ {emails[0]}</p>
                          )}
                          <div className={`flex items-center gap-2 text-xs mt-2 ${MUTED}`}>
                            <span>Deleted: {new Date(contact.updated_at).toLocaleDateString()}</span>
                          </div>
                        </div>

                        <div className="flex flex-wrap justify-end gap-2 ml-4 shrink-0" onClick={(e) => e.stopPropagation()}>
                          <button
                            onClick={() => handleRestoreContact(contact.id)}
                            className={RESTORE}
                            title="Restore contact"
                          >
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                            </svg>
                            Restore
                          </button>
                          <button
                            onClick={() => handlePermanentDeleteContact(contact.id)}
                            className={FOREVER}
                            title="Delete permanently"
                          >
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                            </svg>
                            Delete Forever
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )
          ) : (
            /* Projects Tab — archived projects (restore = unarchive) */
            archivedProjects.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full text-center">
                <svg className="w-16 h-16 text-gilt-a mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                </svg>
                <p className="g-deco text-[15px] text-text mb-2">No Archived Projects</p>
                <p className={MUTED}>Archived projects will appear here</p>
              </div>
            ) : (
              <div className={LIST_GRID}>
                {archivedProjects.map((project) => (
                  <div key={`${project.workspaceId ?? LOCAL_ID}:${project.id}`} className={`${CARD} ${projectColorClass(project)}`}>
                    <div className="flex items-start justify-between gap-4">
                      <span className="g-tile" aria-hidden="true">{projectInitial(project.name)}</span>
                      <div className="flex-1 min-w-0">
                        <h3 className="font-semibold text-text mb-1 truncate">{project.name}</h3>
                        {project.description && (
                          <p className="text-sm text-[color:var(--g-fg2)] line-clamp-2 mb-2">{project.description}</p>
                        )}
                        <div className={`text-xs ${MUTED}`}>Archived</div>
                      </div>
                      <div className="flex flex-wrap justify-end gap-2 shrink-0">
                        <button
                          onClick={() => handleRestoreProject(project)}
                          className={RESTORE}
                          title="Restore project"
                        >
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                          </svg>
                          Restore
                        </button>
                        <button
                          onClick={() => handlePermanentDeleteProject(project)}
                          className={FOREVER}
                          title="Delete permanently"
                        >
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                          </svg>
                          Delete Forever
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )
          )}
        </ScrollArea>
      </div>

      {/* Editor Panel — only for editable bin items (projects use inline actions) */}
      {activeTab === 'tasks' ? (
        <TaskEditor task={selectedTask} onSave={handleTaskSave} onDelete={handleTaskDelete} />
      ) : activeTab === 'events' ? (
        <EventEditor event={selectedEvent} onSave={handleEventSave} onDelete={handleEventDelete} />
      ) : activeTab === 'contacts' ? (
        <ContactEditor contact={selectedContact} onSave={handleContactSave} onDelete={handleContactDelete} onClose={() => setSelectedContact(null)} />
      ) : null}
    </div>
  );
}
