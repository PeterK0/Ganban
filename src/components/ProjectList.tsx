import { useState, useMemo, useEffect, useRef } from 'react';
import { confirmDialog } from '../lib/confirm';
import { useAppStore } from '../store/appStore';
import { createProject, deleteProject, archiveProject, getAreas, toggleProjectPin } from '../lib/api';
import AreaManager from './AreaManager';
import ProjectSettingsModal from './ProjectSettingsModal';
import type { Area } from '../types';

export default function ProjectList() {
  const {
    projects,
    selectedProject,
    selectProject,
    addProject,
    removeProject,
    updateProject,
    selectedAreaId,
    setSelectedAreaId,
  } = useAppStore();

  const [isCreating, setIsCreating] = useState(false);
  const [newProjectName, setNewProjectName] = useState('');
  const [isAreaManagerOpen, setIsAreaManagerOpen] = useState(false);
  const [isProjectSettingsOpen, setIsProjectSettingsOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<'active' | 'archived'>('active');
  const [expandedProjects, setExpandedProjects] = useState<Set<number>>(new Set());
  const [projectAreas, setProjectAreas] = useState<Record<number, Area[]>>({});
  const [openMenuProjectId, setOpenMenuProjectId] = useState<number | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Filter and sort projects based on active tab
  const filteredProjects = useMemo(() => {
    const filtered = projects.filter(project =>
      activeTab === 'active' ? !project.archived : project.archived
    );

    // Sort: pinned projects first (alphabetically), then unpinned (alphabetically)
    return filtered.sort((a, b) => {
      // If one is pinned and the other isn't, pinned comes first
      if (a.pinned && !b.pinned) return -1;
      if (!a.pinned && b.pinned) return 1;

      // If both have same pinned status, sort alphabetically
      return a.name.localeCompare(b.name);
    });
  }, [projects, activeTab]);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setOpenMenuProjectId(null);
      }
    };

    if (openMenuProjectId !== null) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [openMenuProjectId]);

  // Load areas for expanded projects
  useEffect(() => {
    const loadAreasForProjects = async () => {
      for (const projectId of expandedProjects) {
        if (!projectAreas[projectId]) {
          try {
            const areas = await getAreas(projectId);
            setProjectAreas(prev => ({ ...prev, [projectId]: areas }));
          } catch (error) {
            console.error(`Failed to load areas for project ${projectId}:`, error);
          }
        }
      }
    };
    loadAreasForProjects();
  }, [expandedProjects]);

  // Reload areas when area manager closes
  const handleAreaManagerClose = () => {
    setIsAreaManagerOpen(false);
    if (selectedProject) {
      // Reload areas for the current project
      getAreas(selectedProject.id)
        .then(areas => setProjectAreas(prev => ({ ...prev, [selectedProject.id]: areas })))
        .catch(error => console.error('Failed to reload areas:', error));
    }
  };

  const handleCreateProject = async () => {
    if (!newProjectName.trim()) return;

    try {
      const project = await createProject({ name: newProjectName });
      addProject(project);
      setNewProjectName('');
      setIsCreating(false);
      selectProject(project);
    } catch (error) {
      console.error('Failed to create project:', error);
    }
  };

  const handleDeleteProject = async (projectId: number) => {
    try {
      console.log('Deleting project:', projectId);
      await deleteProject(projectId);
      const proj = projects.find((p) => p.id === projectId);
      if (proj) removeProject(proj);
      if (selectedProject?.id === projectId) {
        selectProject(null);
      }
      console.log('Project deleted successfully');
    } catch (error) {
      console.error('Failed to delete project:', error);
      alert(`Failed to delete project: ${error}`);
    }
  };

  const handleArchiveProject = async (projectId: number, archived: boolean) => {
    try {
      console.log('Archiving project:', projectId, archived);
      const updatedProject = await archiveProject(projectId, archived);
      updateProject(updatedProject);
      // If archiving the selected project, deselect it
      if (archived && selectedProject?.id === projectId) {
        selectProject(null);
      }
      console.log('Project archived successfully');
    } catch (error) {
      console.error('Failed to archive project:', error);
      alert(`Failed to archive project: ${error}`);
    }
  };

  const handleTogglePin = async (projectId: number, pinned: boolean) => {
    try {
      console.log('Toggling project pin:', projectId, pinned);
      const updatedProject = await toggleProjectPin(projectId, pinned);
      updateProject(updatedProject);
      console.log('Project pin toggled successfully');
    } catch (error) {
      console.error('Failed to toggle project pin:', error);
      alert(`Failed to toggle project pin: ${error}`);
    }
  };

  const toggleProjectExpanded = (projectId: number) => {
    setExpandedProjects(prev => {
      const newSet = new Set(prev);
      if (newSet.has(projectId)) {
        newSet.delete(projectId);
      } else {
        newSet.add(projectId);
      }
      return newSet;
    });
  };

  const handleAreaSelect = (area: Area) => {
    setSelectedAreaId(area.id);
    // Note: The actual filtering will be handled by TaskList component
    // which will need to be modified to watch for selectedAreaId changes
  };

  const handleProjectSelect = (project: typeof selectedProject) => {
    selectProject(project);
    // Clear area filter when clicking on project
    setSelectedAreaId(null);
  };

  return (
    <>
      <div className="flex flex-col h-full">
        <div className="p-4 border-b border-surface-2">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-lg font-semibold text-text">Projects</h2>
          </div>

          {/* Tabs */}
          <div className="flex gap-1 bg-surface-1 rounded-lg p-1">
            <button
              onClick={() => setActiveTab('active')}
              className={`flex-1 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                activeTab === 'active'
                  ? 'bg-primary text-primary-text'
                  : 'text-subtext-0 hover:text-text'
              }`}
            >
              Active
            </button>
            <button
              onClick={() => setActiveTab('archived')}
              className={`flex-1 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                activeTab === 'archived'
                  ? 'bg-primary text-primary-text'
                  : 'text-subtext-0 hover:text-text'
              }`}
            >
              Archived
            </button>
          </div>
        </div>

      <div className="flex-1 overflow-y-auto p-2">
        {filteredProjects.map((project) => {
          const isExpanded = expandedProjects.has(project.id);
          const areas = projectAreas[project.id] || [];

          return (
            <div key={project.id} className="mb-2">
              <div
                className={`p-3 rounded-lg cursor-pointer transition-colors group ${
                  selectedProject?.id === project.id && selectedAreaId === null
                    ? 'bg-primary text-primary-text'
                    : 'bg-surface-1 hover:bg-surface-2'
                }`}
                onClick={() => handleProjectSelect(project)}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 flex-1 min-w-0">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleProjectExpanded(project.id);
                      }}
                      className="p-0.5 hover:bg-overlay-0/20 rounded transition-colors"
                    >
                      <svg
                        className={`w-4 h-4 transition-transform ${isExpanded ? 'rotate-90' : ''}`}
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M9 5l7 7-7 7"
                        />
                      </svg>
                    </button>
                    {project.pinned && (
                      <svg
                        className="w-4 h-4 text-primary flex-shrink-0"
                        fill="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <title>Pinned</title>
                        <path d="M16 12V4H17V2H7V4H8V12L6 14V16H11.2V22H12.8V16H18V14L16 12Z" />
                      </svg>
                    )}
                    <span className="font-medium truncate">{project.name}</span>
                  </div>
              {selectedProject?.id === project.id && (
                <div className="relative" ref={openMenuProjectId === project.id ? menuRef : null}>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setOpenMenuProjectId(openMenuProjectId === project.id ? null : project.id);
                    }}
                    className="p-1 text-text hover:text-primary transition-colors"
                    title="Project Options"
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
                        d="M12 5v.01M12 12v.01M12 19v.01M12 6a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2z"
                      />
                    </svg>
                  </button>

                  {/* Dropdown Menu */}
                  {openMenuProjectId === project.id && (
                    <div className="absolute right-0 mt-1 w-48 bg-surface-0 border border-surface-2 rounded-lg shadow-lg z-50 py-1">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setIsProjectSettingsOpen(true);
                          setOpenMenuProjectId(null);
                        }}
                        className="w-full px-4 py-2 text-left text-sm text-text hover:bg-surface-1 transition-colors flex items-center gap-2"
                      >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                        </svg>
                        Project Settings
                      </button>

                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setIsAreaManagerOpen(true);
                          setOpenMenuProjectId(null);
                        }}
                        className="w-full px-4 py-2 text-left text-sm text-text hover:bg-surface-1 transition-colors flex items-center gap-2"
                      >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
                        </svg>
                        Manage Areas
                      </button>

                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleTogglePin(project.id, !project.pinned);
                          setOpenMenuProjectId(null);
                        }}
                        className="w-full px-4 py-2 text-left text-sm text-text hover:bg-surface-1 transition-colors flex items-center gap-2"
                      >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          {project.pinned ? (
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                          ) : (
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
                          )}
                        </svg>
                        {project.pinned ? 'Unpin Project' : 'Pin Project'}
                      </button>

                      <div className="border-t border-surface-2 my-1"></div>

                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleArchiveProject(project.id, !project.archived);
                          setOpenMenuProjectId(null);
                        }}
                        className="w-full px-4 py-2 text-left text-sm text-warning hover:bg-surface-1 transition-colors flex items-center gap-2"
                      >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4" />
                        </svg>
                        {project.archived ? 'Unarchive Project' : 'Archive Project'}
                      </button>

                      <button
                        onClick={async (e) => {
                          e.stopPropagation();
                          if (await confirmDialog(`Are you sure you want to delete "${project.name}"? This action cannot be undone.`)) {
                            handleDeleteProject(project.id);
                          }
                          setOpenMenuProjectId(null);
                        }}
                        className="w-full px-4 py-2 text-left text-sm text-error hover:bg-surface-1 transition-colors flex items-center gap-2"
                      >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                        </svg>
                        Delete Project
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
                {project.description && (
                  <p className="text-xs mt-1 text-subtext-0 truncate">
                    {project.description}
                  </p>
                )}
              </div>

              {/* Areas list */}
              {isExpanded && areas.length > 0 && (
                <div className="ml-6 mt-1 space-y-1">
                  {areas.map((area) => (
                    <div
                      key={area.id}
                      onClick={(e) => {
                        e.stopPropagation();
                        handleAreaSelect(area);
                      }}
                      className={`p-2 rounded-md cursor-pointer transition-colors text-sm ${
                        selectedAreaId === area.id
                          ? 'bg-primary/80 text-text'
                          : 'bg-surface-0 hover:bg-surface-2 text-subtext-0 hover:text-text'
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <svg
                          className="w-3.5 h-3.5 flex-shrink-0"
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"
                          />
                        </svg>
                        <span className="truncate">{area.name}</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* Empty state for expanded project with no areas */}
              {isExpanded && areas.length === 0 && (
                <div className="ml-6 mt-1 p-2 text-xs text-subtext-0 italic">
                  No areas yet
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="p-4 border-t border-surface-2">
        {isCreating ? (
          <div className="space-y-2">
            <input
              type="text"
              value={newProjectName}
              onChange={(e) => setNewProjectName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleCreateProject();
                if (e.key === 'Escape') {
                  setIsCreating(false);
                  setNewProjectName('');
                }
              }}
              placeholder="Project name..."
              className="g-field"
              autoFocus
            />
            <div className="flex gap-2">
              <button
                onClick={handleCreateProject}
                className="flex-1 px-3 py-2 bg-primary text-primary-text rounded-lg hover:bg-primary-hover transition-colors"
              >
                Create
              </button>
              <button
                onClick={() => {
                  setIsCreating(false);
                  setNewProjectName('');
                }}
                className="flex-1 px-3 py-2 bg-surface-2 text-text rounded-lg hover:bg-overlay-0 transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button
            onClick={() => setIsCreating(true)}
            className="w-full px-4 py-2 bg-primary text-primary-text rounded-lg hover:bg-primary-hover transition-colors flex items-center justify-center gap-2"
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
            New Project
          </button>
        )}
      </div>
      </div>

      {selectedProject && (
        <>
          <AreaManager
            projectId={selectedProject.id}
            isOpen={isAreaManagerOpen}
            onClose={handleAreaManagerClose}
          />
          <ProjectSettingsModal
            project={selectedProject}
            isOpen={isProjectSettingsOpen}
            onClose={() => setIsProjectSettingsOpen(false)}
            onUpdate={(updatedProject) => {
              updateProject(updatedProject);
              setIsProjectSettingsOpen(false);
            }}
          />
        </>
      )}
    </>
  );
}
