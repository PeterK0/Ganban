import React from 'react';
import { useAppStore } from '../store/appStore';
import type { Task, Area, Project } from '../types';
import MarkdownPreview from './MarkdownPreview';
import { updateTask, updateTaskStatus } from '../lib/api';

interface TaskCardProps {
  task: Task;
  onClick: () => void;
  onStatusChange: (status: string) => void;
  areas?: Area[];
  projects?: Project[];
  isSelected?: boolean;
}

export default function TaskCard({ task, onClick, onStatusChange, areas = [], projects = [], isSelected = false }: TaskCardProps) {
  const { taskTimes, activeTask, setActiveTask } = useAppStore();
  const [isDescriptionExpanded, setIsDescriptionExpanded] = React.useState(false);

  const getAreaName = () => {
    if (!task.area_id) return null;
    const area = areas.find(a => a.id === task.area_id);
    return area?.name;
  };

  const getProjectName = () => {
    const project = projects.find(p => p.id === task.project_id);
    return project?.name ?? null;
  };

  const areaName = getAreaName();
  const projectName = getProjectName();
  const isActive = activeTask?.id === task.id;

  const handlePinToggle = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await updateTask(task.id, { pinned: !task.pinned });
      onStatusChange(task.status); // Trigger refresh
    } catch (error) {
      console.error('Failed to update pin status:', error);
      alert('Failed to update pin status');
    }
  };

  const handleActiveToggle = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isActive) {
      setActiveTask(null);
    } else {
      setActiveTask(task);
    }
  };

  const handlePriorityChange = async (e: React.ChangeEvent<HTMLSelectElement>) => {
    e.stopPropagation();
    const newPriority = e.target.value as Task['priority'];
    try {
      await updateTask(task.id, { priority: newPriority });
      onStatusChange(task.status); // Trigger refresh
    } catch (error) {
      console.error('Failed to update priority:', error);
      alert('Failed to update priority');
    }
  };

  const handleStatusChange = async (e: React.ChangeEvent<HTMLSelectElement>) => {
    e.stopPropagation();
    const newStatus = e.target.value;
    try {
      await updateTaskStatus(task.id, newStatus);
      onStatusChange(newStatus);
    } catch (error) {
      console.error('Failed to update status:', error);
      alert('Failed to update status');
    }
  };

  const handleDoubleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    setActiveTask(task);
  };


  const formatTime = (seconds: number) => {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    return `${hours.toString().padStart(2, '0')}:${minutes
      .toString()
      .padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  const getDeadlineInfo = () => {
    if (!task.deadline) return null;

    const deadline = new Date(task.deadline);
    const now = new Date();
    const diffTime = deadline.getTime() - now.getTime();
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

    if (diffDays < 0) {
      return { label: 'Overdue', color: 'bg-error/20 text-error border border-error/30', urgent: true };
    } else if (diffDays === 0) {
      return { label: 'Due today', color: 'bg-warning/20 text-warning border border-warning/30', urgent: true };
    } else if (diffDays === 1) {
      return { label: 'Due tomorrow', color: 'bg-warning/20 text-warning border border-warning/30', urgent: false };
    } else if (diffDays <= 3) {
      return { label: `${diffDays} days left`, color: 'bg-warning/20 text-warning border border-warning/30', urgent: false };
    } else if (diffDays <= 7) {
      return { label: `${diffDays} days left`, color: 'bg-info/20 text-info border border-info/30', urgent: false };
    }

    return { label: deadline.toLocaleDateString(), color: 'bg-overlay-0/20 text-subtext-0 border border-overlay-0/30', urgent: false };
  };

  const deadlineInfo = getDeadlineInfo();

  return (
    <div
      onClick={onClick}
      onDoubleClick={handleDoubleClick}
      className={`bg-surface-0 p-4 rounded-lg border-2 hover:shadow-md transition-all cursor-pointer relative ${
        isActive ? 'border-success shadow-lg ring-2 ring-success/30' : isSelected ? 'border-primary shadow-lg' : 'border-surface-2'
      }`}
    >
      {/* Pin and Active buttons - Top Right */}
      <div className="absolute top-2 right-2 flex items-center gap-1">
        <button
          onClick={handlePinToggle}
          className={`p-1.5 rounded transition-colors ${
            task.pinned ? 'bg-primary/20 text-primary' : 'bg-surface-1 text-subtext-0 hover:text-text'
          }`}
          title={task.pinned ? 'Unpin task' : 'Pin task'}
        >
          <svg
            className="w-4 h-4"
            fill={task.pinned ? "currentColor" : "none"}
            stroke="currentColor"
            strokeWidth={task.pinned ? 0 : 2}
            viewBox="0 0 24 24"
          >
            <path d="M16 12V4H17V2H7V4H8V12L6 14V16H11.2V22H12.8V16H18V14L16 12Z" />
          </svg>
        </button>

        <button
          onClick={handleActiveToggle}
          className={`p-1.5 rounded transition-colors ${
            isActive ? 'bg-success/20 text-success' : 'bg-surface-1 text-subtext-0 hover:text-text'
          }`}
          title={isActive ? 'Remove as active task' : 'Set as active task'}
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-5.714 2.143L13 21l-2.286-6.857L5 12l5.714-2.143L13 3z" />
          </svg>
        </button>
      </div>

      {/* Header */}
      <div className="mb-2 pr-20">
        {(projectName || areaName) && (
          <div className="text-xs mb-1 flex items-center gap-1 flex-wrap">
            {projectName && <span className="text-subtext-0">{projectName}</span>}
            {projectName && areaName && <span className="text-subtext-0">/</span>}
            {areaName && <span className="text-primary font-medium">{areaName}</span>}
          </div>
        )}
        {/* break-words: an unbroken paste (URL, error string) must not widen the
            card; clamp keeps essay-length titles from burying the list. */}
        <h3 className="font-medium text-text mb-2 break-words line-clamp-3">{task.title}</h3>
      </div>

      {task.description && (
        <div className="mb-3">
          <div className={`text-sm text-subtext-0 min-w-0 break-words ${isDescriptionExpanded ? '' : 'line-clamp-2'}`}>
            <MarkdownPreview content={task.description} />
          </div>
          {task.description.length > 100 && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                setIsDescriptionExpanded(!isDescriptionExpanded);
              }}
              className="text-xs text-primary hover:text-primary-hover mt-1 font-medium"
            >
              {isDescriptionExpanded ? 'Show less' : 'Show more'}
            </button>
          )}
        </div>
      )}

      {/* Tags and metadata */}
      <div className="flex items-center gap-2 flex-wrap mb-3">
        {task.prefix && (
          <span className="px-2 py-1 bg-overlay-0/20 text-subtext-0 border border-overlay-0/30 rounded text-xs">
            {task.prefix}
          </span>
        )}
        {deadlineInfo && (
          <span
            className={`px-2 py-1 rounded text-xs font-medium flex items-center gap-1 ${deadlineInfo.color}`}
          >
            {deadlineInfo.urgent && (
              <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                <path
                  fillRule="evenodd"
                  d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-12a1 1 0 10-2 0v4a1 1 0 00.293.707l2.828 2.829a1 1 0 101.415-1.415L11 9.586V6z"
                  clipRule="evenodd"
                />
              </svg>
            )}
            {deadlineInfo.label}
          </span>
        )}
        {task.cost !== null && task.cost !== undefined && (
          <span className="text-xs text-subtext-0">
            {task.cost} {task.currency || ''}
          </span>
        )}
      </div>

      {/* Action dropdowns row */}
      <div className="flex items-center gap-2 mb-2">
        <select
          value={task.priority}
          onChange={handlePriorityChange}
          onClick={(e) => e.stopPropagation()}
          className="text-xs px-2 py-1 bg-surface-1 border border-surface-2 rounded focus:outline-none focus:ring-2 focus:ring-primary text-text font-medium"
        >
          <option value="Low">Low</option>
          <option value="Medium">Medium</option>
          <option value="High">High</option>
        </select>

        <select
          value={task.status}
          onChange={handleStatusChange}
          onClick={(e) => e.stopPropagation()}
          className="text-xs px-2 py-1 bg-surface-1 border border-surface-2 rounded focus:outline-none focus:ring-2 focus:ring-primary text-text"
        >
          <option value="To Do">To Do</option>
          <option value="In Progress">In Progress</option>
          <option value="Done">Done</option>
          <option value="Blocked">Blocked</option>
        </select>
      </div>

      <div className="mt-2 flex items-center justify-between text-xs text-subtext-0">
        <span>{new Date(task.created_at).toLocaleDateString()}</span>
        {taskTimes[task.id] > 0 && (
          <span className="flex items-center gap-1 text-subtext-1 font-medium">
            <svg
              className="w-3 h-3"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
              />
            </svg>
            {formatTime(taskTimes[task.id])}
          </span>
        )}
      </div>
    </div>
  );
}
