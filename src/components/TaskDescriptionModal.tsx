import { useState, useEffect } from 'react';
import { updateTask as updateTaskApi } from '../lib/api';
import type { Task, UpdateTaskInput } from '../types';
import MarkdownPreview from './MarkdownPreview';
import { Modal } from './gilt';

interface TaskDescriptionModalProps {
  task: Task;
  isOpen: boolean;
  onClose: () => void;
  onSave: (task: Task) => void;
}

export default function TaskDescriptionModal({
  task,
  isOpen,
  onClose,
  onSave,
}: TaskDescriptionModalProps) {
  const [description, setDescription] = useState(task.description || '');
  const [isSaving, setIsSaving] = useState(false);

  // Escape saves and closes. A window capture listener runs before the
  // Modal's own (document, capture), and stops it, so the Modal's onClose is
  // left to the scrim click, which discards.
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        e.stopPropagation();
        handleSaveAndClose();
      }
    };

    if (isOpen) {
      window.addEventListener('keydown', handleEscape, true);
      return () => window.removeEventListener('keydown', handleEscape, true);
    }
  }, [isOpen, description]);

  // Update description when task changes
  useEffect(() => {
    setDescription(task.description || '');
  }, [task.id]);

  const handleSaveAndClose = async () => {
    setIsSaving(true);
    try {
      const input: UpdateTaskInput = {
        description: description || undefined,
      };

      const updatedTask = await updateTaskApi(task.id, input);
      onSave(updatedTask);
      onClose();
    } catch (error) {
      console.error('Failed to update task description:', error);
      alert(`Failed to update description: ${error}`);
    } finally {
      setIsSaving(false);
    }
  };

  const discardAndClose = () => {
    setDescription(task.description || '');
    onClose();
  };

  if (!isOpen) return null;

  // Modal portals to document.body: it must escape the tab content's z-10
  // stacking context (ProjectView wraps active-tab content in `relative z-10`).
  return (
    <Modal onClose={discardAndClose} title="Edit description" className="w-[min(1600px,calc(100vw-64px))] h-[90vh]">
        {/* Header */}
        <div className="px-6 pb-4 -mt-2 border-b border-gilt-b flex items-center gap-4 flex-shrink-0">
          <div className="flex-1 min-w-0">
            <p className="font-semibold text-text truncate">{task.title}</p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handleSaveAndClose}
              disabled={isSaving}
              className="g-btn g-btn-pri g-glint"
            >
              {isSaving ? 'Saving…' : 'Save & close'}
            </button>
            <button
              onClick={discardAndClose}
              className="g-iconbtn"
              title="Close without saving"
              aria-label="Close without saving"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
            </button>
          </div>
        </div>

        {/* Content - Split View */}
        <div className="flex-1 min-h-0 flex overflow-hidden">
          {/* Left Half - Editor */}
          <div className="w-1/2 flex flex-col border-r border-gilt-b">
            <div className="px-6 pt-4 flex-shrink-0">
              <h3 className="g-flbl">Markdown</h3>
            </div>
            <div className="flex-1 min-h-0 px-6 pb-2">
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Write your task description using markdown syntax..."
                aria-label="Description (markdown)"
                className="g-field h-full resize-none font-mono text-sm"
              />
            </div>
            <div className="px-6 py-3 flex-shrink-0">
              <p className="text-xs text-subtext-0">
                Markdown works here: headings, lists, links, code blocks. Esc saves and closes.
              </p>
            </div>
          </div>

          {/* Right Half - Preview */}
          <div className="w-1/2 flex flex-col bg-mantle">
            <div className="px-6 pt-4 flex-shrink-0">
              <h3 className="g-flbl">Preview</h3>
            </div>
            <div className="flex-1 overflow-y-auto px-6 pb-6">
              {description ? (
                <MarkdownPreview content={description} />
              ) : (
                <div className="flex items-center justify-center h-full">
                  <p className="text-subtext-0 italic">
                    Start typing to see the preview…
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>
    </Modal>
  );
}
