import { useState, useEffect } from 'react';
import { confirmDialog } from '../lib/confirm';
import { getTasks, restoreTask, permanentlyDeleteTask } from '../lib/api';
import { useAppStore } from '../store/appStore';
import type { Task } from '../types';
import TaskEditor from './TaskEditor';

export default function TaskBin() {
  const { projects, selectedTask, selectTask } = useAppStore();
  const [deletedTasks, setDeletedTasks] = useState<Task[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    loadDeletedTasks();
  }, [projects]);

  const loadDeletedTasks = async () => {
    setIsLoading(true);
    try {
      // Load archived tasks from all projects
      const tasksPromises = projects.map((project) => getTasks(project.id, true));
      const tasksArrays = await Promise.all(tasksPromises);
      const tasks = tasksArrays.flat().filter(task => task.archived);
      setDeletedTasks(tasks);
    } catch (error) {
      console.error('Failed to load deleted tasks:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleRestore = async (taskId: number) => {
    try {
      await restoreTask(taskId);
      loadDeletedTasks();
    } catch (error) {
      console.error('Failed to restore task:', error);
      alert('Failed to restore task');
    }
  };

  const handlePermanentDelete = async (taskId: number, taskTitle: string) => {
    if (await confirmDialog(`Permanently delete "${taskTitle}"? This cannot be undone.`)) {
      try {
        await permanentlyDeleteTask(taskId);
        loadDeletedTasks();
      } catch (error) {
        console.error('Failed to permanently delete task:', error);
        alert('Failed to permanently delete task');
      }
    }
  };

  const getProjectName = (projectId: number): string => {
    const project = projects.find((p) => p.id === projectId);
    return project?.name || 'Unknown Project';
  };

  const handleTaskSave = () => {
    // For deleted tasks, we don't allow editing
    // Users should restore first, then edit
    console.log('Cannot edit deleted task. Please restore it first.');
  };

  const handleTaskDelete = async () => {
    if (!selectedTask) return;
    // This would be a permanent delete in the bin context
    await handlePermanentDelete(selectedTask.id, selectedTask.title);
  };

  return (
    <div className="flex h-full">
      <div className="flex-1 flex flex-col bg-base">
        {/* Header */}
        <div className="p-6 border-b border-surface-2">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-bold text-text">Task Bin</h1>
              <p className="text-sm text-subtext-0 mt-1">
                Deleted tasks are kept here. Restore them or delete permanently.
              </p>
            </div>
            {deletedTasks.length > 0 && (
              <span className="px-3 py-1 bg-primary/20 text-primary rounded-lg text-sm font-medium">
                {deletedTasks.length} task{deletedTasks.length !== 1 ? 's' : ''}
              </span>
            )}
          </div>
        </div>

        {/* Task List */}
        <div className="flex-1 overflow-y-auto p-6">
          {isLoading ? (
            <div className="flex items-center justify-center h-full">
              <p className="text-subtext-0">Loading deleted tasks...</p>
            </div>
          ) : deletedTasks.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-center">
              <svg
                className="w-20 h-20 text-overlay-0 mb-4"
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
              <p className="text-xl text-text font-semibold mb-2">Task Bin is Empty</p>
              <p className="text-subtext-0">Deleted tasks will appear here</p>
            </div>
          ) : (
            <div className="space-y-3">
              {deletedTasks.map((task) => (
                <div
                  key={task.id}
                  onClick={() => selectTask(task)}
                  className={`p-4 bg-surface-0 border-2 rounded-lg hover:border-primary transition-all cursor-pointer ${
                    selectedTask?.id === task.id ? 'border-primary shadow-lg' : 'border-surface-2'
                  }`}
                >
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      <div className="text-xs text-subtext-0 mb-1">
                        {getProjectName(task.project_id)}
                      </div>
                      <h3 className="font-semibold text-text mb-1">
                        {task.prefix && (
                          <span className="text-primary mr-1">[{task.prefix}]</span>
                        )}
                        {task.title}
                      </h3>
                      {task.description && (
                        <p className="text-sm text-subtext-0 line-clamp-2 mb-2">
                          {task.description}
                        </p>
                      )}
                      <div className="flex items-center gap-2 text-xs text-subtext-0">
                        <span>Deleted: {new Date(task.updated_at).toLocaleDateString()}</span>
                        <span>•</span>
                        <span className="px-2 py-0.5 bg-surface-2 rounded">
                          {task.status}
                        </span>
                        <span className="px-2 py-0.5 bg-surface-2 rounded">
                          {task.priority}
                        </span>
                      </div>
                    </div>

                    <div className="flex gap-2 ml-4" onClick={(e) => e.stopPropagation()}>
                      <button
                        onClick={() => handleRestore(task.id)}
                        className="px-3 py-2 bg-primary text-primary-text rounded-lg hover:bg-primary-hover transition-colors flex items-center gap-2"
                        title="Restore task"
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
                            d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                          />
                        </svg>
                        Restore
                      </button>
                      <button
                        onClick={() => handlePermanentDelete(task.id, task.title)}
                        className="px-3 py-2 bg-error/20 text-error rounded-lg hover:bg-error/30 transition-colors flex items-center gap-2"
                        title="Delete permanently"
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
                        Delete Forever
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Task Editor Panel - Always Visible */}
      <TaskEditor
        task={selectedTask}
        onSave={handleTaskSave}
        onDelete={handleTaskDelete}
      />
    </div>
  );
}
