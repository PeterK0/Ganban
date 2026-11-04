import { create } from 'zustand';
import type { RangePreset, ReportGrouping } from '../lib/reportGenerator';
import { persist } from 'zustand/middleware';
import type { Project, Task, Area } from '../types';
import { defaultTheme } from '../themes';
import { setActiveWorkspace, LOCAL_ID } from '../lib/workspaces';

/** K2: a project is identified by (workspace, id) — ids collide across hosts
 * (every DB starts at 1). Absent workspaceId means the local workspace. */
const wsOf = (p: { workspaceId?: string }) => p.workspaceId ?? LOCAL_ID;
export const sameProject = (a: Project | null, b: Project | null): boolean =>
  !!a && !!b && a.id === b.id && wsOf(a) === wsOf(b);

interface AppState {
  // Projects
  projects: Project[];
  selectedProject: Project | null;
  setProjects: (projects: Project[]) => void;
  selectProject: (project: Project | null) => void;
  addProject: (project: Project) => void;
  updateProject: (project: Project) => void;
  removeProject: (project: Project) => void;

  // Tasks
  tasks: Task[];
  selectedTask: Task | null;
  activeTask: Task | null;
  setTasks: (tasks: Task[]) => void;
  selectTask: (task: Task | null) => void;
  setActiveTask: (task: Task | null) => void;
  addTask: (task: Task) => void;
  updateTask: (task: Task) => void;
  removeTask: (taskId: number) => void;

  // Areas
  areas: Area[];
  selectedAreaId: number | null;
  setAreas: (areas: Area[]) => void;
  addArea: (area: Area) => void;
  setSelectedAreaId: (areaId: number | null) => void;

  // Time tracking
  taskTimes: Record<number, number>; // taskId -> total seconds
  setTaskTime: (taskId: number, seconds: number) => void;

  // Theme
  currentTheme: string;
  setTheme: (theme: string) => void;

  // UI State
  isLoading: boolean;
  setIsLoading: (isLoading: boolean) => void;
  error: string | null;
  setError: (error: string | null) => void;
  // K2: composite 'workspace:id' (ids collide across hosts), not a bare id.
  homeBoardProjectFilter: string | null;
  setHomeBoardProjectFilter: (key: string | null) => void;
  /** "Open {project}'s Comments" from Home: land on this project's Comments tab with
   * these tasks filtered. Consumed (cleared) by ProjectView. Not persisted. */
  commentBoardIntent: { projectKey: string; taskIds: number[] } | null;
  setCommentBoardIntent: (intent: { projectKey: string; taskIds: number[] } | null) => void;

  // Report Settings. The PERIOD is persisted as a preset ("this week"), never
  // as the dates it resolved to — persisting literal dates froze one week's
  // range into a stale default forever. Start/end only feed the Custom preset.
  reportSelectedProjects: number[];
  reportRange: RangePreset;
  reportStartDate: string;
  reportEndDate: string;
  reportSelectedStatuses: string[];
  reportGrouping: ReportGrouping;
  reportVerbose: boolean;
  reportIncludeTime: boolean;
  reportIncludeAssignees: boolean;
  reportIncludeEvents: boolean;
  reportUserName: string;
  setReportSelectedProjects: (projects: number[]) => void;
  setReportRange: (range: RangePreset) => void;
  setReportStartDate: (date: string) => void;
  setReportEndDate: (date: string) => void;
  setReportSelectedStatuses: (statuses: string[]) => void;
  setReportGrouping: (grouping: ReportGrouping) => void;
  setReportVerbose: (verbose: boolean) => void;
  setReportIncludeTime: (v: boolean) => void;
  setReportIncludeAssignees: (v: boolean) => void;
  setReportIncludeEvents: (v: boolean) => void;
  setReportUserName: (name: string) => void;
}

export const useAppStore = create<AppState>()(
  persist(
    (set) => ({
      // Projects
      projects: [],
      selectedProject: null,
      setProjects: (projects) => set({ projects }),
      // Selecting a project repoints the active workspace at its host (K2), so
      // every project-scoped call (tasks, tabs, chat, files) routes correctly
      // through the existing transport seam — no per-call threading.
      selectProject: (project) => {
        if (project) setActiveWorkspace(project.workspaceId ?? LOCAL_ID);
        set({ selectedProject: project });
      },
      addProject: (project) =>
        set((state) => ({ projects: [...state.projects, project] })),
      updateProject: (project) =>
        set((state) => ({
          projects: state.projects.map((p) => (sameProject(p, project) ? project : p)),
          selectedProject: sameProject(state.selectedProject, project) ? project : state.selectedProject,
        })),
      removeProject: (project) =>
        set((state) => ({
          projects: state.projects.filter((p) => !sameProject(p, project)),
          selectedProject: sameProject(state.selectedProject, project) ? null : state.selectedProject,
        })),

      // Tasks
      tasks: [],
      selectedTask: null,
      activeTask: null,
      setTasks: (tasks) => set({ tasks }),
      selectTask: (task) => set({ selectedTask: task }),
      setActiveTask: (task) => set({ activeTask: task }),
      addTask: (task) => set((state) => ({ tasks: [...state.tasks, task] })),
      updateTask: (task) =>
        set((state) => ({
          tasks: state.tasks.map((t) => (t.id === task.id ? task : t)),
          selectedTask: state.selectedTask?.id === task.id ? task : state.selectedTask,
          activeTask: state.activeTask?.id === task.id ? task : state.activeTask,
        })),
      removeTask: (taskId) =>
        set((state) => ({
          tasks: state.tasks.filter((t) => t.id !== taskId),
          selectedTask: state.selectedTask?.id === taskId ? null : state.selectedTask,
          activeTask: state.activeTask?.id === taskId ? null : state.activeTask,
        })),

      // Areas
      areas: [],
      selectedAreaId: null,
      setAreas: (areas) => set({ areas }),
      addArea: (area) => set((state) => ({ areas: [...state.areas, area] })),
      setSelectedAreaId: (areaId) => set({ selectedAreaId: areaId }),

      // Time tracking
      taskTimes: {},
      setTaskTime: (taskId, seconds) =>
        set((state) => ({
          taskTimes: { ...state.taskTimes, [taskId]: seconds },
        })),

      // Theme
      currentTheme: defaultTheme,
      setTheme: (theme) => set({ currentTheme: theme }),

      // UI State
      isLoading: false,
      setIsLoading: (isLoading) => set({ isLoading }),
      error: null,
      setError: (error) => set({ error }),
      homeBoardProjectFilter: null,
      setHomeBoardProjectFilter: (projectId) => set({ homeBoardProjectFilter: projectId }),
      commentBoardIntent: null,
      setCommentBoardIntent: (intent) => set({ commentBoardIntent: intent }),

      // Report Settings
      reportSelectedProjects: [],
      reportRange: 'this-week',
      reportStartDate: '',
      reportEndDate: '',
      reportSelectedStatuses: ['To Do', 'In Progress', 'Blocked', 'Done'],
      reportGrouping: 'status',
      reportVerbose: false,
      reportIncludeTime: true,
      reportIncludeAssignees: true,
      reportIncludeEvents: true,
      reportUserName: '',
      setReportSelectedProjects: (projects) => set({ reportSelectedProjects: projects }),
      setReportRange: (range) => set({ reportRange: range }),
      setReportStartDate: (date) => set({ reportStartDate: date }),
      setReportEndDate: (date) => set({ reportEndDate: date }),
      setReportSelectedStatuses: (statuses) => set({ reportSelectedStatuses: statuses }),
      setReportGrouping: (grouping) => set({ reportGrouping: grouping }),
      setReportVerbose: (verbose) => set({ reportVerbose: verbose }),
      setReportIncludeTime: (v) => set({ reportIncludeTime: v }),
      setReportIncludeAssignees: (v) => set({ reportIncludeAssignees: v }),
      setReportIncludeEvents: (v) => set({ reportIncludeEvents: v }),
      setReportUserName: (name) => set({ reportUserName: name }),
    }),
    {
      name: 'ganban-storage',
      partialize: (state) => ({
        currentTheme: state.currentTheme,
        reportSelectedProjects: state.reportSelectedProjects,
        reportRange: state.reportRange,
        reportStartDate: state.reportStartDate,
        reportEndDate: state.reportEndDate,
        reportSelectedStatuses: state.reportSelectedStatuses,
        reportGrouping: state.reportGrouping,
        reportVerbose: state.reportVerbose,
        reportIncludeTime: state.reportIncludeTime,
        reportIncludeAssignees: state.reportIncludeAssignees,
        reportIncludeEvents: state.reportIncludeEvents,
        reportUserName: state.reportUserName,
      }),
      migrate: (persistedState: any) => {
        // Migrate data from old 'gansty-storage' key to new 'ganban-storage' key
        if (typeof window !== 'undefined') {
          const oldData = localStorage.getItem('gansty-storage');
          if (oldData) {
            try {
              const parsed = JSON.parse(oldData);
              console.log('Migrating data from gansty-storage to ganban-storage');
              // Remove old key after successful migration
              localStorage.removeItem('gansty-storage');
              return parsed.state || persistedState;
            } catch (error) {
              console.error('Failed to migrate storage data:', error);
            }
          }
        }
        return persistedState;
      },
    }
  )
);
