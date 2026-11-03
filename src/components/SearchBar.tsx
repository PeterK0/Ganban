import { useState, useEffect, useRef } from 'react';
import Fuse from 'fuse.js';
import { useAppStore } from '../store/appStore';
import { getActiveWorkspaceId, LOCAL_ID } from '../lib/workspaces';
import { getTasks, getTaskComments, getEvents } from '../lib/api';
import type { Task, Comment, Event } from '../types';
import type { DetailTarget } from './DetailPane';

interface SearchResult {
  type: 'task' | 'event';
  task?: Task;
  event?: Event;
  matchType: 'title' | 'description' | 'comment' | 'location';
  matchedText?: string;
}

export default function SearchBar({ onSelectResult }: { onSelectResult?: (target: DetailTarget) => void } = {}) {
  const { projects, selectTask, activeTask } = useAppStore();
  const [searchQuery, setSearchQuery] = useState('');
  const [isOpen, setIsOpen] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const [results, setResults] = useState<SearchResult[]>([]);
  const [allTasks, setAllTasks] = useState<Task[]>([]);
  const [allEvents, setAllEvents] = useState<Event[]>([]);
  const [taskComments, setTaskComments] = useState<Record<number, Comment[]>>({});
  const [isLoading, setIsLoading] = useState(false);
  const searchRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Load all tasks and events on mount
  useEffect(() => {
    loadAllTasks();
    loadAllEvents();
  }, [projects]);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (searchRef.current && !searchRef.current.contains(event.target as Node)) {
        setIsOpen(false);
        setIsExpanded(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Keyboard shortcut (Cmd+K or Ctrl+K)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setIsExpanded(true);
        setIsOpen(true);
        // Focus input after a brief delay to ensure it's rendered
        setTimeout(() => inputRef.current?.focus(), 0);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const loadAllTasks = async () => {
    setIsLoading(true);
    try {
      // K2: search the ACTIVE workspace (tasks come over the active transport).
      // Skip ARCHIVED (binned) projects — their tasks belong in the Bin, not in
      // search results.
      const activeWs = getActiveWorkspaceId();
      const scoped = projects.filter((p) => !p.archived && (p.workspaceId ?? LOCAL_ID) === activeWs);
      const tasksPromises = scoped.map(project => getTasks(project.id, false));
      const tasksArrays = await Promise.all(tasksPromises);
      const tasks = tasksArrays.flat();
      setAllTasks(tasks);

      // Load comments for all tasks
      const commentsMap: Record<number, Comment[]> = {};
      await Promise.all(
        tasks.map(async (task) => {
          try {
            const comments = await getTaskComments(task.id);
            commentsMap[task.id] = comments;
          } catch (error) {
            console.error(`Failed to load comments for task ${task.id}:`, error);
          }
        })
      );
      setTaskComments(commentsMap);
    } catch (error) {
      console.error('Failed to load tasks:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const loadAllEvents = async () => {
    try {
      // Load all non-archived events
      const events = await getEvents(undefined, undefined, false);
      setAllEvents(events);
    } catch (error) {
      console.error('Failed to load events:', error);
    }
  };

  useEffect(() => {
    if (searchQuery.trim()) {
      performSearch(searchQuery);
    } else {
      setResults([]);
    }
  }, [searchQuery, allTasks, allEvents, taskComments]);

  const performSearch = (query: string) => {
    const searchResults: SearchResult[] = [];

    // Search in task titles
    const titleFuse = new Fuse(allTasks, {
      keys: ['title'],
      threshold: 0.3,
      includeScore: true,
    });
    const titleResults = titleFuse.search(query);
    titleResults.forEach(result => {
      searchResults.push({
        type: 'task',
        task: result.item,
        matchType: 'title',
      });
    });

    // Search in task descriptions
    const descriptionFuse = new Fuse(
      allTasks.filter(t => t.description),
      {
        keys: ['description'],
        threshold: 0.4,
        includeScore: true,
      }
    );
    const descriptionResults = descriptionFuse.search(query);
    descriptionResults.forEach(result => {
      if (!searchResults.some(r => r.type === 'task' && r.task?.id === result.item.id)) {
        searchResults.push({
          type: 'task',
          task: result.item,
          matchType: 'description',
        });
      }
    });

    // Search in comments
    Object.entries(taskComments).forEach(([taskIdStr, comments]) => {
      const taskId = Number(taskIdStr);
      const task = allTasks.find(t => t.id === taskId);
      if (!task) return;

      const commentFuse = new Fuse(comments, {
        keys: ['content'],
        threshold: 0.4,
        includeScore: true,
      });
      const commentResults = commentFuse.search(query);

      if (commentResults.length > 0 && !searchResults.some(r => r.type === 'task' && r.task?.id === taskId)) {
        searchResults.push({
          type: 'task',
          task,
          matchType: 'comment',
          matchedText: commentResults[0].item.content.substring(0, 100),
        });
      }
    });

    // Search in event titles
    const eventTitleFuse = new Fuse(allEvents, {
      keys: ['title'],
      threshold: 0.3,
      includeScore: true,
    });
    const eventTitleResults = eventTitleFuse.search(query);
    eventTitleResults.forEach(result => {
      searchResults.push({
        type: 'event',
        event: result.item,
        matchType: 'title',
      });
    });

    // Search in event descriptions
    const eventDescriptionFuse = new Fuse(
      allEvents.filter(e => e.description),
      {
        keys: ['description'],
        threshold: 0.4,
        includeScore: true,
      }
    );
    const eventDescriptionResults = eventDescriptionFuse.search(query);
    eventDescriptionResults.forEach(result => {
      if (!searchResults.some(r => r.type === 'event' && r.event?.id === result.item.id)) {
        searchResults.push({
          type: 'event',
          event: result.item,
          matchType: 'description',
        });
      }
    });

    // Search in event locations
    const eventLocationFuse = new Fuse(
      allEvents.filter(e => e.location),
      {
        keys: ['location'],
        threshold: 0.4,
        includeScore: true,
      }
    );
    const eventLocationResults = eventLocationFuse.search(query);
    eventLocationResults.forEach(result => {
      if (!searchResults.some(r => r.type === 'event' && r.event?.id === result.item.id)) {
        searchResults.push({
          type: 'event',
          event: result.item,
          matchType: 'location',
          matchedText: result.item.location,
        });
      }
    });

    setResults(searchResults.slice(0, 10)); // Limit to 10 results
  };

  const handleResultClick = (result: SearchResult) => {
    if (result.type === 'task' && result.task) {
      selectTask(result.task); // keep global selection in sync
      onSelectResult?.({ kind: 'task', task: result.task });
    } else if (result.type === 'event' && result.event) {
      onSelectResult?.({ kind: 'event', event: result.event });
    }
    setIsOpen(false);
    setIsExpanded(false);
    setSearchQuery('');
  };

  const getProjectName = (projectId: number) => {
    const project = projects.find(p => p.id === projectId);
    return project?.name || 'Unknown';
  };

  const formatEventDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  };

  // No active task: inline expansion
  if (!activeTask) {
    return (
      // The field opens leftwards OVER the bar (absolute), so expanding it
      // never changes the top bar's layout or its fit.
      <div ref={searchRef} className="relative w-9 h-9 shrink-0">
        <div
          className={`absolute right-0 top-0 h-9 flex items-center rounded transition-all duration-300 overflow-hidden ${
            isExpanded ? 'w-80 z-40 bg-base ring-1 ring-inset ring-gilt-a shadow-xl' : 'w-9 hover:bg-surface-0'
          }`}
        >
          <button
            onClick={() => {
              if (!isExpanded) {
                setIsExpanded(true);
                setIsOpen(true);
                setTimeout(() => inputRef.current?.focus(), 100);
              }
            }}
            className="w-9 h-9 grid place-items-center flex-shrink-0 text-subtext-1 hover:text-text rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-gold"
            title="Search tasks and events (⌘K)"
            aria-label="Search"
          >
            <svg
              className="w-[18px] h-[18px]"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
              />
            </svg>
          </button>
          {isExpanded && (
            <input
              ref={inputRef}
              type="text"
              value={searchQuery}
              onChange={(e) => {
                setSearchQuery(e.target.value);
                setIsOpen(true);
              }}
              onFocus={() => setIsOpen(true)}
              placeholder="Search..."
              className="flex-1 min-w-0 pr-4 h-9 bg-transparent focus:outline-none text-text placeholder:text-subtext-0 text-sm"
            />
          )}
        </div>

        {/* Search Results Dropdown - Inline mode */}
        {isOpen && searchQuery.trim() && isExpanded && (
          <div className="g-card g-corners absolute right-0 top-full mt-3 w-96 shadow-2xl z-50 max-h-96 overflow-y-auto whitespace-normal">
            {isLoading ? (
              <div className="p-4 text-center text-subtext-0 text-sm">Loading...</div>
            ) : results.length > 0 ? (
              <div className="py-2">
                {results.map((result, index) => (
                  <button
                    key={`${result.type}-${result.type === 'task' ? result.task?.id : result.event?.id}-${index}`}
                    onClick={() => handleResultClick(result)}
                    className="w-full px-4 py-3 hover:bg-surface-0 transition-colors text-left flex items-start gap-3"
                  >
                    <div className="flex-1 min-w-0">
                      {result.type === 'task' && result.task ? (
                        <>
                          <div className="flex items-center gap-2 mb-1">
                            <svg className="w-4 h-4 text-success flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
                            </svg>
                            <span className="text-sm font-medium text-text truncate">
                              {result.task.title}
                            </span>
                            <span className="px-2 py-0.5 bg-surface-0 rounded-full text-xs text-subtext-0">
                              {result.matchType}
                            </span>
                          </div>
                          <div className="flex items-center gap-2 text-xs text-subtext-0 ml-6">
                            <span>{getProjectName(result.task.project_id)}</span>
                            <span>•</span>
                            <span>{result.task.status}</span>
                            <span>•</span>
                            <span>{result.task.priority}</span>
                          </div>
                          {result.matchedText && (
                            <p className="text-xs text-subtext-0 mt-1 line-clamp-1 ml-6">
                              {result.matchedText}...
                            </p>
                          )}
                        </>
                      ) : result.type === 'event' && result.event ? (
                        <>
                          <div className="flex items-center gap-2 mb-1">
                            <svg className="w-4 h-4 text-warning flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                            </svg>
                            <span className="text-sm font-medium text-text truncate">
                              {result.event.title}
                            </span>
                            <span className="px-2 py-0.5 bg-warning/15 text-warning rounded-full text-xs">
                              {result.matchType}
                            </span>
                          </div>
                          <div className="flex items-center gap-2 text-xs text-subtext-0 ml-6">
                            <span>{formatEventDate(result.event.event_date)}</span>
                            {result.event.start_time && (
                              <>
                                <span>•</span>
                                <span>{result.event.start_time}</span>
                              </>
                            )}
                            {result.event.location && (
                              <>
                                <span>•</span>
                                <span className="truncate">📍 {result.event.location}</span>
                              </>
                            )}
                          </div>
                          {result.matchedText && result.matchType === 'location' && (
                            <p className="text-xs text-subtext-0 mt-1 line-clamp-1 ml-6">
                              📍 {result.matchedText}
                            </p>
                          )}
                        </>
                      ) : null}
                    </div>
                  </button>
                ))}
              </div>
            ) : (
              <div className="p-4 text-center text-subtext-0 text-sm">
                No results found for "{searchQuery}"
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  // Active task present: dropdown expansion (lowered to avoid overlap)
  return (
    <div ref={searchRef} className="relative">
      {!isExpanded ? (
        // Collapsed: Show button
        <button
          onClick={() => {
            setIsExpanded(true);
            setIsOpen(true);
            setTimeout(() => inputRef.current?.focus(), 0);
          }}
          className="g-iconbtn"
          title="Search tasks and events (⌘K)"
          aria-label="Search"
        >
          <svg
            className="w-[18px] h-[18px]"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
            />
          </svg>
        </button>
      ) : (
        // Expanded: Show search panel (lowered with more margin)
        <div className="g-card g-corners absolute right-0 top-full mt-3 shadow-2xl z-50 w-96 whitespace-normal">
          <div className="relative p-4 border-b border-gilt-b">
            <input
              ref={inputRef}
              type="text"
              value={searchQuery}
              onChange={(e) => {
                setSearchQuery(e.target.value);
                setIsOpen(true);
              }}
              onFocus={() => setIsOpen(true)}
              placeholder="Search tasks and events..."
              className="w-full pl-10 pr-4 min-h-[38px] bg-mantle border border-gilt-a rounded focus:outline-none focus:border-gold text-text placeholder:text-subtext-0 text-sm"
            />
            <svg
              className="absolute left-7 top-1/2 -translate-y-1/2 w-4 h-4 text-subtext-0"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
              />
            </svg>
          </div>

          {/* Search Results */}
          {isOpen && searchQuery.trim() && (
            <div className="max-h-96 overflow-y-auto">
              {isLoading ? (
                <div className="p-4 text-center text-subtext-0 text-sm">Loading...</div>
              ) : results.length > 0 ? (
                <div className="py-2">
                  {results.map((result, index) => (
                    <button
                      key={`${result.type}-${result.type === 'task' ? result.task?.id : result.event?.id}-${index}`}
                      onClick={() => handleResultClick(result)}
                      className="w-full px-4 py-3 hover:bg-surface-0 transition-colors text-left flex items-start gap-3"
                    >
                      <div className="flex-1 min-w-0">
                        {result.type === 'task' && result.task ? (
                          <>
                            <div className="flex items-center gap-2 mb-1">
                              <svg className="w-4 h-4 text-success flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
                              </svg>
                              <span className="text-sm font-medium text-text truncate">
                                {result.task.title}
                              </span>
                              <span className="px-2 py-0.5 bg-surface-0 rounded-full text-xs text-subtext-0">
                                {result.matchType}
                              </span>
                            </div>
                            <div className="flex items-center gap-2 text-xs text-subtext-0 ml-6">
                              <span>{getProjectName(result.task.project_id)}</span>
                              <span>•</span>
                              <span>{result.task.status}</span>
                              <span>•</span>
                              <span>{result.task.priority}</span>
                            </div>
                            {result.matchedText && (
                              <p className="text-xs text-subtext-0 mt-1 line-clamp-1 ml-6">
                                {result.matchedText}...
                              </p>
                            )}
                          </>
                        ) : result.type === 'event' && result.event ? (
                          <>
                            <div className="flex items-center gap-2 mb-1">
                              <svg className="w-4 h-4 text-warning flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                              </svg>
                              <span className="text-sm font-medium text-text truncate">
                                {result.event.title}
                              </span>
                              <span className="px-2 py-0.5 bg-warning/15 text-warning rounded-full text-xs">
                                {result.matchType}
                              </span>
                            </div>
                            <div className="flex items-center gap-2 text-xs text-subtext-0 ml-6">
                              <span>{formatEventDate(result.event.event_date)}</span>
                              {result.event.start_time && (
                                <>
                                  <span>•</span>
                                  <span>{result.event.start_time}</span>
                                </>
                              )}
                              {result.event.location && (
                                <>
                                  <span>•</span>
                                  <span className="truncate">📍 {result.event.location}</span>
                                </>
                              )}
                            </div>
                            {result.matchedText && result.matchType === 'location' && (
                              <p className="text-xs text-subtext-0 mt-1 line-clamp-1 ml-6">
                                📍 {result.matchedText}
                              </p>
                            )}
                          </>
                        ) : null}
                      </div>
                    </button>
                  ))}
                </div>
              ) : (
                <div className="p-4 text-center text-subtext-0 text-sm">
                  No results found for "{searchQuery}"
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
