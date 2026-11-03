import { useState, useEffect } from 'react';
import {
  startTimeEntry,
  stopTimeEntry,
  getActiveTimeEntry,
} from '../lib/api';
import type { TimeEntry } from '../types';

interface TimerWidgetProps {
  taskId: number;
  onTimerUpdate: () => void;
}

export default function TimerWidget({ taskId, onTimerUpdate }: TimerWidgetProps) {
  const [activeEntry, setActiveEntry] = useState<TimeEntry | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    loadActiveEntry();
  }, [taskId]);

  useEffect(() => {
    if (!activeEntry) {
      setElapsed(0);
      return;
    }

    // Update elapsed time every second
    const interval = setInterval(() => {
      const start = new Date(activeEntry.start_time).getTime();
      const now = Date.now();
      setElapsed(Math.floor((now - start) / 1000));
    }, 1000);

    return () => clearInterval(interval);
  }, [activeEntry]);

  const loadActiveEntry = async () => {
    try {
      const entry = await getActiveTimeEntry(taskId);
      setActiveEntry(entry);
      if (entry) {
        const start = new Date(entry.start_time).getTime();
        const now = Date.now();
        setElapsed(Math.floor((now - start) / 1000));
      }
    } catch (error) {
      console.error('Failed to load active entry:', error);
    }
  };

  const handleStart = async () => {
    setIsLoading(true);
    try {
      const entry = await startTimeEntry(taskId);
      setActiveEntry(entry);
      onTimerUpdate();
    } catch (error) {
      console.error('Failed to start timer:', error);
      alert(error instanceof Error ? error.message : 'Failed to start timer');
    } finally {
      setIsLoading(false);
    }
  };

  const handleStop = async () => {
    if (!activeEntry) return;

    setIsLoading(true);
    try {
      await stopTimeEntry(activeEntry.id);
      setActiveEntry(null);
      setElapsed(0);
      onTimerUpdate();
    } catch (error) {
      console.error('Failed to stop timer:', error);
      alert('Failed to stop timer');
    } finally {
      setIsLoading(false);
    }
  };

  const formatTime = (seconds: number) => {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    return `${hours.toString().padStart(2, '0')}:${minutes
      .toString()
      .padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  return (
    <div className="bg-surface-1 rounded-lg p-4 border border-surface-2">
      <div className="flex items-center justify-between mb-3">
        <h4 className="font-medium text-text">Timer</h4>
        {activeEntry && (
          <span className="flex items-center text-sm text-success">
            <span className="w-2 h-2 bg-success rounded-full mr-2 animate-pulse"></span>
            Recording
          </span>
        )}
      </div>

      <div className="text-center mb-4">
        <div className="text-4xl font-mono font-bold text-text">
          {formatTime(elapsed)}
        </div>
        {activeEntry && (
          <p className="text-xs text-subtext-0 mt-1">
            Started at {new Date(activeEntry.start_time).toLocaleTimeString()}
          </p>
        )}
      </div>

      <div className="flex gap-2">
        {!activeEntry ? (
          <button
            onClick={handleStart}
            disabled={isLoading}
            className="flex-1 px-4 py-2 bg-success text-white rounded-lg hover:bg-success/80 disabled:opacity-50 flex items-center justify-center gap-2"
          >
            <svg
              className="w-5 h-5"
              fill="currentColor"
              viewBox="0 0 24 24"
            >
              <path d="M8 5v14l11-7z" />
            </svg>
            Start Timer
          </button>
        ) : (
          <button
            onClick={handleStop}
            disabled={isLoading}
            className="flex-1 px-4 py-2 bg-error text-white rounded-lg hover:bg-error/80 disabled:opacity-50 flex items-center justify-center gap-2"
          >
            <svg
              className="w-5 h-5"
              fill="currentColor"
              viewBox="0 0 24 24"
            >
              <rect x="6" y="6" width="12" height="12" />
            </svg>
            Stop Timer
          </button>
        )}
      </div>
    </div>
  );
}
