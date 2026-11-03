import { useState, useEffect } from 'react';
import { getAreas, createArea, updateArea, deleteArea, getTasks, getAreaMembers, setAreaMembers, setAreaRestricted } from '../lib/api';
import { useProjectRole } from '../lib/projectRole';
import type { Area } from '../types';
import ScrollArea from './ScrollArea';
import { Modal } from './gilt';
import { areaGem } from './taskMarks';

interface AreaManagerProps {
  projectId: number;
  isOpen: boolean;
  onClose: () => void;
}

export default function AreaManager({ projectId, isOpen, onClose }: AreaManagerProps) {
  const [areas, setAreas] = useState<Area[]>([]);
  const [areTaskCounts, setAreaTaskCounts] = useState<Record<number, number>>({});
  const [isCreating, setIsCreating] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [newAreaName, setNewAreaName] = useState('');
  const [newAreaDescription, setNewAreaDescription] = useState('');
  const [editAreaName, setEditAreaName] = useState('');
  const [editAreaDescription, setEditAreaDescription] = useState('');
  // Task visibility (ADR 0002): who each area's members are, and the one being edited.
  const { members, canManage } = useProjectRole(isOpen ? projectId : null);
  const [areaMembers, setAreaMemberMap] = useState<Record<number, number[]>>({});
  const [sharing, setSharing] = useState<{ areaId: number; restricted: boolean; members: number[] } | null>(null);
  const nameOf = (id: number) => members.find((m) => m.user_id === id)?.display_name ?? `User ${id}`;

  useEffect(() => {
    if (isOpen && projectId) {
      loadAreas();
    }
  }, [isOpen, projectId]);

  // Handle Escape key: close any open editor first; otherwise the Modal closes
  // itself. Window capture runs before the Modal's document-capture listener,
  // so stopping it here keeps an editor's Esc from closing the whole modal.
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen && (isCreating || editingId !== null)) {
        e.stopPropagation();
        if (isCreating) {
          setIsCreating(false);
          setNewAreaName('');
          setNewAreaDescription('');
        } else if (editingId !== null) {
          setEditingId(null);
          setEditAreaName('');
          setEditAreaDescription('');
        }
      }
    };

    if (isOpen) {
      window.addEventListener('keydown', handleEscape, true);
      return () => window.removeEventListener('keydown', handleEscape, true);
    }
  }, [isOpen, isCreating, editingId, onClose]);

  const loadAreas = async () => {
    try {
      const data = await getAreas(projectId);
      setAreas(data);

      // Load task counts for each area
      const tasks = await getTasks(projectId, false);
      const counts: Record<number, number> = {};

      // Count tasks per area
      tasks.forEach(task => {
        if (task.area_id) {
          counts[task.area_id] = (counts[task.area_id] || 0) + 1;
        }
      });

      setAreaTaskCounts(counts);
      const lists = await Promise.all(data.map((a) => getAreaMembers(a.id).then((ids) => [a.id, ids] as const).catch(() => [a.id, []] as const)));
      setAreaMemberMap(Object.fromEntries(lists));
    } catch (error) {
      console.error('Failed to load areas:', error);
    }
  };

  const saveSharing = async () => {
    if (!sharing) return;
    try {
      await setAreaMembers(sharing.areaId, sharing.members);
      await setAreaRestricted(sharing.areaId, sharing.restricted);
      setSharing(null);
      loadAreas();
    } catch (error) {
      alert(`Could not change who sees this area: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const handleCreate = async () => {
    if (!newAreaName.trim()) return;

    try {
      await createArea({
        project_id: projectId,
        name: newAreaName,
        description: newAreaDescription || undefined,
      });
      setNewAreaName('');
      setNewAreaDescription('');
      setIsCreating(false);
      loadAreas();
    } catch (error) {
      console.error('Failed to create area:', error);
      alert(`Failed to create area: ${error}`);
    }
  };

  const handleUpdate = async (areaId: number) => {
    if (!editAreaName.trim()) return;

    try {
      await updateArea(areaId, {
        name: editAreaName,
        description: editAreaDescription || undefined,
      });
      setEditingId(null);
      setEditAreaName('');
      setEditAreaDescription('');
      loadAreas();
    } catch (error) {
      console.error('Failed to update area:', error);
      alert(`Failed to update area: ${error}`);
    }
  };

  const handleDelete = async (areaId: number) => {
    try {
      await deleteArea(areaId);
      setDeletingId(null);
      loadAreas();
    } catch (error) {
      console.error('Failed to delete area:', error);
      alert(`Failed to delete area: ${error}`);
      setDeletingId(null);
    }
  };

  const confirmDelete = (areaId: number) => {
    setDeletingId(areaId);
  };

  const cancelDelete = () => {
    setDeletingId(null);
  };

  const startEdit = (area: Area) => {
    setEditingId(area.id);
    setEditAreaName(area.name);
    setEditAreaDescription(area.description || '');
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditAreaName('');
    setEditAreaDescription('');
  };

  if (!isOpen) return null;

  return (
    <Modal onClose={onClose} title="Manage Areas" className="w-[680px] max-h-[90vh]">
          <button
            onClick={onClose}
            className="g-iconbtn absolute top-4 right-4"
            title="Close"
            aria-label="Close"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>

          {/* Content */}
          <ScrollArea className="flex-1 min-h-0" contentClassName="px-6 pb-6 pt-1">
            <div className="space-y-3">
              {/* Existing Areas */}
              {areas.map((area) => (
                <div
                  key={area.id}
                  className="g-plain p-4"
                >
                  {editingId === area.id ? (
                    <div className="space-y-3">
                      <input
                        type="text"
                        value={editAreaName}
                        onChange={(e) => setEditAreaName(e.target.value)}
                        placeholder="Area name..."
                        className="g-field"
                        autoFocus
                      />
                      <textarea
                        value={editAreaDescription}
                        onChange={(e) => setEditAreaDescription(e.target.value)}
                        placeholder="Description (optional)..."
                        rows={2}
                        className="g-field resize-none"
                      />
                      <div className="flex gap-2">
                        <button
                          onClick={() => handleUpdate(area.id)}
                          className="g-btn g-btn-pri g-btn-sm flex-1"
                        >
                          Save
                        </button>
                        <button
                          onClick={cancelEdit}
                          className="g-btn g-btn-ghost g-btn-sm flex-1"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : deletingId === area.id ? (
                    // Delete confirmation
                    <div className="space-y-3">
                      <div className="flex items-start gap-3">
                        <div className="p-2 bg-error/15 rounded">
                          <svg className="w-6 h-6 text-error" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                          </svg>
                        </div>
                        <div className="flex-1">
                          <h4 className="font-semibold text-text mb-1">Delete "{area.name}"?</h4>
                          {areTaskCounts[area.id] > 0 && area.restricted ? (
                            <p className="text-sm text-warning">
                              This restricted area contains {areTaskCounts[area.id]} task{areTaskCounts[area.id] !== 1 ? 's' : ''}. They
                              keep their audience: each becomes "Selected members" with the area's members
                              ({(areaMembers[area.id] ?? []).map(nameOf).join(', ') || 'none'}), so only they and admins see it.
                            </p>
                          ) : areTaskCounts[area.id] > 0 ? (
                            <p className="text-sm text-error">
                              Warning: This area contains {areTaskCounts[area.id]} task{areTaskCounts[area.id] !== 1 ? 's' : ''}. Tasks will not be deleted, but they will lose their area assignment.
                            </p>
                          ) : (
                            <p className="text-sm text-subtext-0">
                              This area is empty and can be safely deleted.
                            </p>
                          )}
                        </div>
                      </div>
                      <div className="flex gap-2">
                        <button
                          onClick={() => handleDelete(area.id)}
                          className="g-btn g-btn-danger g-btn-sm flex-1"
                        >
                          Delete Area
                        </button>
                        <button
                          onClick={cancelDelete}
                          className="g-btn g-btn-ghost g-btn-sm flex-1"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div>
                      <div className="flex items-center justify-between gap-3 mb-1">
                        <div className="flex flex-wrap items-center gap-2 min-w-0">
                          <span className={`g-gem ${areaGem(area.id)}`} aria-hidden="true" />
                          <h3 className="font-semibold text-text">{area.name}</h3>
                          {areTaskCounts[area.id] > 0 && (
                            <span className="g-tag">
                              {areTaskCounts[area.id]} task{areTaskCounts[area.id] !== 1 ? 's' : ''}
                            </span>
                          )}
                          {area.restricted && (
                            <span
                              className="g-tag g-tag-warn"
                              title="Only its members and admins see this area and its tasks"
                            >
                              🔒 {(areaMembers[area.id] ?? []).map(nameOf).join(', ') || 'no members yet'}
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          {canManage && (
                            <button
                              onClick={() => setSharing({ areaId: area.id, restricted: !!area.restricted, members: areaMembers[area.id] ?? [] })}
                              className="g-btn g-btn-ghost g-btn-sm"
                              title="Who sees this area and its tasks"
                            >
                              Who sees it
                            </button>
                          )}
                          <button
                            onClick={() => startEdit(area)}
                            className="g-iconbtn !w-8 !h-8"
                            title="Edit"
                            aria-label="Edit"
                          >
                            <svg
                              className="w-4 h-4"
                              fill="none"
                              stroke="currentColor"
                              viewBox="0 0 24 24"
                            >
                              <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth={2}
                                d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
                              />
                            </svg>
                          </button>
                          <button
                            onClick={() => confirmDelete(area.id)}
                            className="g-iconbtn !w-8 !h-8 hover:!text-error"
                            title="Delete"
                            aria-label="Delete"
                          >
                            <svg
                              className="w-4 h-4"
                              fill="none"
                              stroke="currentColor"
                              viewBox="0 0 24 24"
                            >
                              <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth={2}
                                d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                              />
                            </svg>
                          </button>
                        </div>
                      </div>
                      {area.description && (
                        <p className="text-sm text-[color:var(--g-fg2)] max-w-[72ch]">{area.description}</p>
                      )}
                      {sharing?.areaId === area.id && (
                        <div className="g-card mt-3 p-4 space-y-3">
                          <label className="flex items-start gap-2 text-sm text-text cursor-pointer">
                            <input
                              type="checkbox"
                              className="mt-0.5"
                              checked={sharing.restricted}
                              onChange={(e) => setSharing({ ...sharing, restricted: e.target.checked })}
                            />
                            <span>
                              Restricted: only its members see this area and its tasks
                              <span className="block text-xs text-subtext-0">
                                Admins and a task's assignees always see it. A task can narrow further in its own settings.
                              </span>
                            </span>
                          </label>
                          <div>
                            <div className="g-deco text-[11px] font-semibold text-gold mb-2">Area members</div>
                            <div className="flex flex-wrap gap-1.5">
                              {/* Admins and the owner see everything anyway. */}
                              {members.filter((m) => m.role === 'member').map((m) => {
                                const on = sharing.members.includes(m.user_id);
                                return (
                                  <button
                                    key={m.user_id}
                                    onClick={() =>
                                      setSharing({
                                        ...sharing,
                                        members: on ? sharing.members.filter((id) => id !== m.user_id) : [...sharing.members, m.user_id],
                                      })
                                    }
                                    aria-pressed={on}
                                    className={`inline-flex items-center min-h-8 px-3 rounded-full text-[13px] font-medium transition-colors ${
                                      on ? 'g-on' : 'text-[color:var(--g-fg2)] hover:bg-surface-0 hover:text-text'
                                    }`}
                                  >
                                    {m.display_name}
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                          <div className="flex gap-2 justify-end">
                            <button onClick={() => setSharing(null)} className="g-btn g-btn-ghost g-btn-sm">
                              Cancel
                            </button>
                            <button onClick={saveSharing} className="g-btn g-btn-pri g-btn-sm">
                              Save
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ))}

              {/* Create New Area */}
              {isCreating ? (
                <div className="g-plain p-4 space-y-3">
                  <input
                    type="text"
                    value={newAreaName}
                    onChange={(e) => setNewAreaName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleCreate();
                      if (e.key === 'Escape') {
                        setIsCreating(false);
                        setNewAreaName('');
                        setNewAreaDescription('');
                      }
                    }}
                    placeholder="Area name..."
                    className="g-field"
                    autoFocus
                  />
                  <textarea
                    value={newAreaDescription}
                    onChange={(e) => setNewAreaDescription(e.target.value)}
                    placeholder="Description (optional)..."
                    rows={2}
                    className="g-field resize-none"
                  />
                  <div className="flex gap-2">
                    <button
                      onClick={handleCreate}
                      className="g-btn g-btn-pri g-btn-sm flex-1"
                    >
                      Create
                    </button>
                    <button
                      onClick={() => {
                        setIsCreating(false);
                        setNewAreaName('');
                        setNewAreaDescription('');
                      }}
                      className="g-btn g-btn-ghost g-btn-sm flex-1"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  onClick={() => setIsCreating(true)}
                  className="g-btn g-btn-gilt w-full min-h-12 border border-dashed border-gilt-a !shadow-none"
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
                      d="M12 4v16m8-8H4"
                    />
                  </svg>
                  Add New Area
                </button>
              )}
            </div>
          </ScrollArea>

          {/* Footer */}
          <div className="flex-none px-6 py-4 border-t border-gilt-b flex justify-end">
            <button onClick={onClose} className="g-btn g-btn-pri min-w-[8rem]">
              Done
            </button>
          </div>
    </Modal>
  );
}
