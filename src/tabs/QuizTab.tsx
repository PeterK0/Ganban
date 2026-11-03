/**
 * Quizzes tab — the QuizForge adoption (same playbook as the Model Assembly
 * Assistant → Models tab): Subject → Topic → question bank + quizzes, with a
 * quiz runner that grades and records attempts.
 *
 * All nine QuizForge types have an editor widget and a runner widget; data_json
 * keeps QuizForge's shapes (options / blanks / matches / items / variables +
 * answers). Grading mirrors QuizForge: single-answer types are all-or-nothing,
 * multi-part types (blanks, pairs, positions, calculation answers) earn
 * partial credit per part, "correct" meaning every part. Fields the widgets
 * don't know about (unit, formula, decimalPlaces…) survive a save untouched.
 *
 * Oracle's quiz.generate node drafts questions from project files — through
 * the approval gate, never directly into the bank.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip as ChartTooltip, ReferenceLine } from 'recharts';
import {
  getQuizSubjects, createQuizSubject, deleteQuizSubject,
  getQuizTopics, createQuizTopic, deleteQuizTopic,
  getQuizQuestions, createQuizQuestion, updateQuizQuestion, deleteQuizQuestion,
  createQuiz, deleteQuiz, getQuizAttempts, recordQuizAttempt,
  getSubjectQuizQuestions, getSubjectQuizzes,
  updateQuizTopic, updateQuizSubject, moveQuizQuestions, mergeQuizTopics,
  getQuizLeaderboard, getQuizLeaderboardOptin, setQuizLeaderboardOptin,
  type QuizLeaderboardRow,
} from '../lib/api';
import { useDataPulse } from '../lib/livePulse';
import { confirmDialog } from '../lib/confirm';
import ScrollArea from '../components/ScrollArea';
import { useContextMenu } from '../components/ContextMenu';
import { notify } from '../store/notifications';
import type {
  QuizSubject, QuizTopic, QuizQuestion, QuizDef, QuizAttempt, QuizQuestionType, QuizDifficulty,
} from '../types';
import {
  grade, parseData, norm, alternates, isChoice, orderedItems,
  type Option, type Blank, type DropdownBlank, type MatchPair, type OrderItem, type CalcVariable, type CalcAnswer,
} from '../lib/quizGrade';

const DIFF_META: Record<QuizDifficulty, { label: string; tint: string }> = {
  EASY: { label: 'Easy', tint: 'bg-success/15 text-success' },
  MEDIUM: { label: 'Medium', tint: 'bg-warning/15 text-warning' },
  HARD: { label: 'Hard', tint: 'bg-error/15 text-error' },
};

const TYPE_LABEL: Record<QuizQuestionType, string> = {
  SINGLE_CHOICE: 'Single choice',
  MULTIPLE_CHOICE: 'Multiple choice',
  FILL_BLANK: 'Fill blank',
  FILL_BLANK_MULTIPLE: 'Fill blanks (dropdown)',
  NUMERIC_INPUT: 'Numeric',
  MATCHING: 'Matching',
  ORDERING: 'Ordering',
  IMAGE_IDENTIFICATION: 'Image ID',
  CALCULATION: 'Calculation',
};

const SUBJECT_COLORS = ['#A78BFA', '#F06D6D', '#46D38A', '#E5C07B', '#7DC4E4', '#E88BDE'];
const SUBJECT_ICONS = ['📘', '📙', '📗', '📕', '📓', '🧮', '⚗️', '🚢', '💹', '🌍'];

/** The topic-id scope of a quiz/exam (null = whole subject). */
function quizScopeTopicIds(z: QuizDef): number[] | null {
  if (z.topic_ids_json) {
    try {
      const ids = JSON.parse(z.topic_ids_json) as number[];
      if (ids.length > 0) return ids;
    } catch { /* fall through */ }
  }
  if (z.topic_id != null) return [z.topic_id];
  return null;
}

/** Every type the runner renders — all nine, since the widget port. */
const RUNNABLE: QuizQuestionType[] = Object.keys(TYPE_LABEL) as QuizQuestionType[];

// ── the tab ──────────────────────────────────────────────────────────────────

export default function QuizTab({ projectId }: { projectId: number }) {
  const [subjects, setSubjects] = useState<QuizSubject[]>([]);
  const [topics, setTopics] = useState<QuizTopic[]>([]);
  const [selSubject, setSelSubject] = useState<number | null>(null);
  const [selTopic, setSelTopic] = useState<number | null>(null);
  const [questions, setQuestions] = useState<QuizQuestion[]>([]);
  const [quizzes, setQuizzes] = useState<QuizDef[]>([]);
  const [exams, setExams] = useState<QuizDef[]>([]);
  const [subjectPool, setSubjectPool] = useState<QuizQuestion[]>([]);
  const [view, setView] = useState<'questions' | 'quizzes' | 'exams' | 'analytics'>('questions');
  const [query, setQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState<'all' | QuizQuestionType>('all');
  const [diffFilter, setDiffFilter] = useState<'all' | QuizDifficulty>('all');
  const [editing, setEditing] = useState<QuizQuestion | 'new' | null>(null);
  const [running, setRunning] = useState<QuizDef | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [newSubject, setNewSubject] = useState<string | null>(null);
  const [newTopic, setNewTopic] = useState<string | null>(null);
  const [renamingTopic, setRenamingTopic] = useState<{ id: number; name: string } | null>(null);
  const [renamingSubject, setRenamingSubject] = useState<{ id: number; name: string } | null>(null);
  const [attemptsVersion, setAttemptsVersion] = useState(0);
  const [reviewing, setReviewing] = useState<{ attempt: QuizAttempt; quiz: QuizDef } | null>(null);
  const menu = useContextMenu();

  const err = (e: unknown) => setMsg(e instanceof Error ? e.message : String(e));

  const loadSubjects = useCallback(async () => {
    try {
      const ss = await getQuizSubjects(projectId);
      setSubjects(ss);
      setSelSubject((cur) => cur ?? ss[0]?.id ?? null);
    } catch (e) {
      err(e);
    }
  }, [projectId]);

  const loadTopics = useCallback(async (subjectId: number) => {
    try {
      const ts = await getQuizTopics(subjectId);
      setTopics(ts);
      setSelTopic((cur) => (ts.some((t) => t.id === cur) ? cur : ts[0]?.id ?? null));
    } catch (e) {
      err(e);
    }
  }, []);

  // Topic fetches race: click Options while Futures is still loading over a
  // slow tailnet and Futures' answer lands LAST — the list shows one topic under
  // another's highlight. Only the most recent request may write.
  const topicReq = useRef(0);
  const loadTopicData = useCallback(async (topicId: number) => {
    const seq = ++topicReq.current;
    try {
      const qs = await getQuizQuestions(topicId);
      if (seq === topicReq.current) setQuestions(qs);
    } catch (e) {
      if (seq === topicReq.current) err(e);
    }
  }, []);

  const loadSubjectData = useCallback(async (subjectId: number) => {
    try {
      const [all, pool] = await Promise.all([getSubjectQuizzes(subjectId), getSubjectQuizQuestions(subjectId)]);
      // ONE list from the server; kind splits the views.
      setQuizzes(all.filter((z) => z.kind !== 'exam'));
      setExams(all.filter((z) => z.kind === 'exam'));
      setSubjectPool(pool);
    } catch (e) {
      err(e);
    }
  }, []);

  useEffect(() => { void loadSubjects(); }, [loadSubjects]);
  useEffect(() => { if (selSubject != null) { void loadTopics(selSubject); void loadSubjectData(selSubject); } }, [selSubject, loadTopics, loadSubjectData]);
  useEffect(() => { if (selTopic != null) void loadTopicData(selTopic); else { setQuestions([]); setQuizzes([]); } }, [selTopic, loadTopicData]);
  useDataPulse(() => {
    void loadSubjects();
    if (selSubject != null) { void loadTopics(selSubject); void loadSubjectData(selSubject); }
    if (selTopic != null) void loadTopicData(selTopic);
  }, ['quiz']);

  const refresh = () => {
    if (selTopic != null) void loadTopicData(selTopic);
    if (selSubject != null) void loadSubjectData(selSubject);
    setAttemptsVersion((v) => v + 1); // analytics + attempt lists refetch
  };

  const subject = subjects.find((x) => x.id === selSubject) ?? null;
  const selTopicName = topics.find((t) => t.id === selTopic)?.name ?? null;
  // Quizzes are subject-level with a topic scope; the rail's topic click
  // narrows this view to quizzes that DRAW FROM that topic (whole-subject
  // quizzes included — they draw from every topic). Off = the whole subject.
  const [quizTopicFilter, setQuizTopicFilter] = useState(true);
  const shownQuizzes = quizTopicFilter && selTopic != null
    ? quizzes.filter((z) => { const scope = quizScopeTopicIds(z); return scope == null || scope.includes(selTopic); })
    : quizzes;
  const shownQuestions = questions.filter((q) => {
    if (typeFilter !== 'all' && q.question_type !== typeFilter) return false;
    if (diffFilter !== 'all' && q.difficulty !== diffFilter) return false;
    const t = query.trim().toLowerCase();
    if (t && !`${q.question_text} ${q.source ?? ''}`.toLowerCase().includes(t)) return false;
    return true;
  });

  return (
    <div className="flex-1 min-w-0 h-full flex min-h-0 bg-base text-text">
      {menu.element}
      {/* Library rail — subjects with their topics nested (hot-bar feedback:
          topics do not deserve half the screen; they are children). */}
      <div className="w-64 shrink-0 border-r border-gilt-a bg-mantle flex flex-col min-h-0">
        <div className="g-bar justify-between px-3 h-12 shrink-0">
          <span className="g-stitle">Library</span>
          <button onClick={() => setNewSubject('')} className="g-iconbtn !w-8 !h-8 text-sm" title="New subject">＋</button>
        </div>
        <ScrollArea className="flex-1" contentClassName="p-2 space-y-1">
          {newSubject !== null && (
            <input
              autoFocus
              value={newSubject}
              onChange={(e) => setNewSubject(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && newSubject.trim()) {
                  const icon = SUBJECT_ICONS[subjects.length % SUBJECT_ICONS.length];
                  const color = SUBJECT_COLORS[subjects.length % SUBJECT_COLORS.length];
                  void createQuizSubject(projectId, newSubject.trim(), color, icon).then(() => { setNewSubject(null); void loadSubjects(); }).catch(err);
                }
                if (e.key === 'Escape') setNewSubject(null);
              }}
              onBlur={() => setNewSubject(null)}
              placeholder="Subject name…"
              className="w-full px-2.5 py-1.5 text-sm bg-surface-1 border border-primary/40 rounded-lg focus:outline-none"
            />
          )}
          {subjects.map((sub) => {
            const active = selSubject === sub.id;
            const color = sub.color ?? '#A78BFA';
            return (
              <div key={sub.id} className="rounded overflow-hidden border" style={{ borderColor: active ? `${color}66` : 'var(--color-surface-0)' }}>
                <button
                  onClick={() => setSelSubject(sub.id)}
                  onContextMenu={(e) => menu.open(e, [
                    { label: 'New topic', icon: '＋', onClick: () => { setSelSubject(sub.id); setNewTopic(''); } },
                    { label: 'Rename', icon: '✏️', onClick: () => setRenamingSubject({ id: sub.id, name: sub.name }) },
                    { label: 'Delete subject', icon: '🗑', danger: true, divider: true, onClick: () => {
                      void confirmDialog(`Delete “${sub.name}” and every topic, question and quiz under it?`).then((ok) => {
                        if (ok) void deleteQuizSubject(sub.id).then(() => { if (selSubject === sub.id) setSelSubject(null); void loadSubjects(); }).catch(err);
                      });
                    } },
                  ])}
                  className="w-full text-left px-3 py-2 flex items-center gap-2"
                  style={{ background: active ? `${color}14` : 'transparent' }}
                >
                  <span className="text-base">{sub.icon ?? '📘'}</span>
                  {renamingSubject?.id === sub.id ? (
                    <input
                      autoFocus
                      value={renamingSubject.name}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => setRenamingSubject({ id: sub.id, name: e.target.value })}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && renamingSubject.name.trim()) {
                          void updateQuizSubject(sub.id, { name: renamingSubject.name.trim() }).then(() => { setRenamingSubject(null); void loadSubjects(); }).catch(err);
                        }
                        if (e.key === 'Escape') setRenamingSubject(null);
                      }}
                      onBlur={() => setRenamingSubject(null)}
                      className="flex-1 min-w-0 px-1.5 py-0.5 text-sm bg-surface-1 border border-primary/40 rounded focus:outline-none"
                    />
                  ) : (
                    <span className={`text-sm truncate flex-1 ${active ? 'text-text font-medium' : 'text-subtext-1'}`}>{sub.name}</span>
                  )}
                  <span className="w-2 h-2 rounded-full shrink-0" style={{ background: color }} />
                </button>
                {active && (
                  <div className="pb-1.5 px-1.5 space-y-0.5">
                    {topics.map((t) =>
                      renamingTopic?.id === t.id ? (
                        <input
                          key={t.id}
                          autoFocus
                          value={renamingTopic.name}
                          onChange={(e) => setRenamingTopic({ id: t.id, name: e.target.value })}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' && renamingTopic.name.trim()) {
                              void updateQuizTopic(t.id, { name: renamingTopic.name.trim() }).then(() => { setRenamingTopic(null); void loadTopics(sub.id); }).catch(err);
                            }
                            if (e.key === 'Escape') setRenamingTopic(null);
                          }}
                          onBlur={() => setRenamingTopic(null)}
                          className="ml-5 px-2 py-1 text-[13px] bg-surface-1 border border-primary/40 rounded-lg focus:outline-none"
                          style={{ width: 'calc(100% - 1.25rem)' }}
                        />
                      ) : (
                        <button
                          key={t.id}
                          onClick={() => setSelTopic(t.id)}
                          onContextMenu={(e) => menu.open(e, [
                            { label: 'Rename', icon: '✏️', onClick: () => setRenamingTopic({ id: t.id, name: t.name }) },
                            {
                              label: 'Merge into', icon: '🫱',
                              children: topics.filter((o) => o.id !== t.id).map((o) => ({
                                label: o.name,
                                onClick: () => {
                                  void confirmDialog(`Merge “${t.name}” into “${o.name}”? Its questions and quizzes move over; “${t.name}” is deleted.`).then((ok) => {
                                    if (ok) void mergeQuizTopics(t.id, o.id).then(() => { if (selTopic === t.id) setSelTopic(o.id); void loadTopics(sub.id); void loadSubjectData(sub.id); }).catch(err);
                                  });
                                },
                              })),
                            },
                            { label: 'Delete topic', icon: '🗑', danger: true, divider: true, onClick: () => {
                              void confirmDialog(`Delete “${t.name}” with its questions and quizzes?`).then((ok) => {
                                if (ok) void deleteQuizTopic(t.id).then(() => { void loadTopics(sub.id); void loadSubjectData(sub.id); }).catch(err);
                              });
                            } },
                          ])}
                          className={`w-full text-left pl-7 pr-2 py-1 rounded-lg text-[13px] truncate ${
                            selTopic === t.id ? 'bg-gilt-b text-gold' : 'text-subtext-1 hover:bg-surface-0'
                          }`}
                        >
                          {t.name}
                        </button>
                      )
                    )}
                    {newTopic !== null ? (
                      <input
                        autoFocus
                        value={newTopic}
                        onChange={(e) => setNewTopic(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && newTopic.trim()) {
                            void createQuizTopic(sub.id, newTopic.trim()).then(() => { setNewTopic(null); void loadTopics(sub.id); }).catch(err);
                          }
                          if (e.key === 'Escape') setNewTopic(null);
                        }}
                        onBlur={() => setNewTopic(null)}
                        placeholder="Topic name…"
                        className="w-full ml-5 px-2 py-1 text-[13px] bg-surface-1 border border-primary/40 rounded-lg focus:outline-none"
                        style={{ width: 'calc(100% - 1.25rem)' }}
                      />
                    ) : (
                      <button onClick={() => setNewTopic('')} className="w-full text-left pl-7 pr-2 py-1 rounded-lg text-[12px] text-gold hover:bg-surface-0">
                        ＋ topic
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
          {subjects.length === 0 && newSubject === null && (
            <p className="p-2 text-xs text-subtext-0 italic">No subjects yet — ＋ to create one (e.g. “Commodity Derivatives”).</p>
          )}
        </ScrollArea>
      </div>

      {/* Main */}
      <div className="flex-1 min-w-0 flex flex-col min-h-0">
        {/* Subject banner */}
        {subject && (
          <div
            className="shrink-0 px-5 py-3 border-b border-gilt-b flex items-center gap-3"
            style={{ background: `linear-gradient(90deg, ${subject.color ?? '#A78BFA'}22, transparent 60%)` }}
          >
            <span className="text-2xl">{subject.icon ?? '📘'}</span>
            <div className="min-w-0 flex-1">
              <div className="font-deco text-xl font-light tracking-[0.12em] uppercase text-text truncate">{subject.name}</div>
              <div className="text-[11px] text-subtext-0">
                {topics.length} topic{topics.length === 1 ? '' : 's'} · {subjectPool.length} question{subjectPool.length === 1 ? '' : 's'} in the subject bank
              </div>
            </div>
          </div>
        )}

        <div className="g-bar shrink-0 px-4 py-2 flex-wrap">
          <div className="g-seg">
            {([['questions', `📝 Bank (${questions.length})`], ['quizzes', `🎯 Quizzes (${quizzes.length})`], ['exams', `🏆 Exams (${exams.length})`], ['analytics', '📈 Analytics']] as const).map(([v, label]) => (
              <button
                key={v}
                onClick={() => setView(v)}
                className={`g-chip ${view === v ? 'g-on' : ''}`}
              >
                {label}
              </button>
            ))}
          </div>
          {view === 'questions' && (
            <>
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search questions…"
                className="g-field g-field-sm !w-44"
              />
              <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value as typeof typeFilter)} className="g-field g-field-sm !w-auto">
                <option value="all">All types</option>
                {(Object.keys(TYPE_LABEL) as QuizQuestionType[]).map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
              </select>
              <select value={diffFilter} onChange={(e) => setDiffFilter(e.target.value as typeof diffFilter)} className="g-field g-field-sm !w-auto">
                <option value="all">Any difficulty</option>
                <option value="EASY">Easy</option>
                <option value="MEDIUM">Medium</option>
                <option value="HARD">Hard</option>
              </select>
            </>
          )}
          <span className="flex-1" />
          {view === 'questions' && (
            <button
              onClick={() => setEditing('new')}
              disabled={selSubject == null}
              title={selTopic == null ? 'Pick a topic in the editor — or create one there' : undefined}
              className="g-btn g-btn-sm g-btn-pri"
            >
              ＋ Question
            </button>
          )}
          {view === 'quizzes' && (
            <NewQuizButton subjectId={selSubject} topics={topics} defaultTopicIds={selTopic != null ? [selTopic] : []} bankSize={subjectPool.filter((q) => RUNNABLE.includes(q.question_type)).length} onCreated={refresh} onError={err} />
          )}
          {view === 'exams' && (
            <NewQuizButton subjectId={selSubject} topics={topics} defaultTopicIds={topics.map((t) => t.id)} bankSize={subjectPool.filter((q) => RUNNABLE.includes(q.question_type)).length} onCreated={refresh} onError={err} exam />
          )}
        </div>

        {msg && (
          <div className="px-4 py-1.5 text-xs text-error border-b border-gilt-b flex items-center gap-2">
            <span className="flex-1">{msg}</span>
            <button onClick={() => setMsg(null)} className="text-subtext-0 hover:text-text">✕</button>
          </div>
        )}

        <ScrollArea className="flex-1" contentClassName="p-4 space-y-2">
          {view === 'analytics' && selSubject != null ? (
            <SubjectAnalytics
              projectId={projectId}
              subjectId={selSubject}
              quizzes={quizzes}
              exams={exams}
              pool={subjectPool}
              topics={topics}
              refreshKey={attemptsVersion}
            />
          ) : view === 'exams' && selSubject != null ? (
            <>
              {exams.map((z) => (
                <QuizCard key={z.id} quiz={z} topics={topics} refreshKey={attemptsVersion} onRun={() => setRunning(z)} onReview={(a) => setReviewing({ attempt: a, quiz: z })} onDeleted={refresh} onError={err} />
              ))}
              {exams.length === 0 && (
                <p className="text-sm text-subtext-0 italic">
                  No exams yet. An exam draws from EVERY topic under {subject?.name ?? 'this subject'} — the mock-exam simulator.
                </p>
              )}
            </>
          ) : view === 'quizzes' && selSubject != null ? (
            <>
              {selTopic != null && quizzes.length > 0 && (
                <div className="flex items-center gap-2 text-[11px] text-subtext-0 pb-1">
                  {quizTopicFilter ? (
                    <>
                      <span>Drawing from <span className="text-text">{selTopicName}</span> — {shownQuizzes.length} of {quizzes.length}</span>
                      <button onClick={() => setQuizTopicFilter(false)} className="g-lnk !min-h-0 !p-0">Show all in {subject?.name ?? 'subject'}</button>
                    </>
                  ) : (
                    <>
                      <span>All {quizzes.length} in {subject?.name ?? 'the subject'}</span>
                      <button onClick={() => setQuizTopicFilter(true)} className="g-lnk !min-h-0 !p-0">Only those drawing from {selTopicName}</button>
                    </>
                  )}
                </div>
              )}
              {shownQuizzes.map((z) => (
                <QuizCard key={z.id} quiz={z} topics={topics} refreshKey={attemptsVersion} onRun={() => setRunning(z)} onReview={(a) => setReviewing({ attempt: a, quiz: z })} onDeleted={refresh} onError={err} />
              ))}
              {quizzes.length === 0 && <p className="text-sm text-subtext-0 italic">No quizzes yet — ＋ Quiz picks the topics it draws from.</p>}
              {quizzes.length > 0 && shownQuizzes.length === 0 && (
                <p className="text-sm text-subtext-0 italic">No quiz draws from {selTopicName}.</p>
              )}
            </>
          ) : selTopic == null ? (
            <p className="text-sm text-subtext-0 italic">Pick (or create) a subject and a topic — the question bank lives per topic.</p>
          ) : view === 'questions' ? (
            <>
              {shownQuestions.map((q) => (
                <button
                  key={q.id}
                  onClick={() => setEditing(q)}
                  onContextMenu={(e) => menu.open(e, [
                    { label: 'Edit', icon: '✏️', onClick: () => setEditing(q) },
                    {
                      label: 'Move to', icon: '📂',
                      children: topics.filter((t) => t.id !== q.topic_id).map((t) => ({
                        label: t.name,
                        onClick: () => void moveQuizQuestions([q.id], t.id).then(refresh).catch(err),
                      })),
                    },
                    { label: 'Delete', icon: '🗑', danger: true, divider: true, onClick: () => {
                      void confirmDialog('Delete this question?').then((ok) => {
                        if (ok) void deleteQuizQuestion(q.id).then(refresh).catch(err);
                      });
                    } },
                  ])}
                  className={`w-full text-left rounded px-3 py-2 border transition-colors ${
                    editing !== 'new' && editing?.id === q.id
                      ? 'bg-gilt-b border-gilt-a shadow-[inset_0_0_0_1px_var(--color-gilt-a)]'
                      : 'bg-base border-surface-0 hover:border-gilt-a'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] font-bold uppercase px-1.5 py-0.5 rounded bg-surface-0 text-subtext-1 shrink-0">{TYPE_LABEL[q.question_type]}</span>
                    <span className={`text-[10px] px-1.5 py-0.5 rounded ${DIFF_META[q.difficulty].tint} shrink-0`}>{DIFF_META[q.difficulty].label}</span>
                    <span className="text-[10px] text-subtext-0 shrink-0">{q.points} pt{q.points === 1 ? '' : 's'}</span>
                    {q.source && <span className="text-[10px] text-subtext-0 truncate">· {q.source}</span>}
                  </div>
                  <div className="text-sm text-text mt-1 line-clamp-2">{q.question_text}</div>
                </button>
              ))}
              {questions.length === 0 && (
                <p className="text-sm text-subtext-0 italic">
                  Empty bank. Add questions by hand, or wire a <b>Generate quiz questions</b> node in Assistant › Oracle to draft them from a project file — they arrive as approval proposals.
                </p>
              )}
              {questions.length > 0 && shownQuestions.length === 0 && (
                <p className="text-sm text-subtext-0 italic">No questions match the filters.</p>
              )}
            </>
          ) : null}
        </ScrollArea>
      </div>

      {/* Question editor (contained right panel, ProjectView pattern) */}
      <div className={`shrink-0 border-l border-gilt-a bg-base overflow-hidden transition-all duration-200 ${editing ? 'w-96' : 'w-0 border-l-0'}`}>
        {editing && selSubject != null && (
          <div className="w-96 h-full">
            <QuestionEditor
              key={editing === 'new' ? 'new' : editing.id}
              topicId={selTopic}
              topics={topics}
              subjectId={selSubject}
              question={editing === 'new' ? null : editing}
              onClose={() => setEditing(null)}
              onSaved={(topicId) => {
                setEditing(null);
                // Follow the question: if it was filed under another topic,
                // select that topic so what you just saved is what you see.
                if (topicId !== selTopic) { void loadTopics(selSubject); setSelTopic(topicId); }
                refresh();
              }}
              onError={err}
            />
          </div>
        )}
      </div>

      {reviewing && (
        <AttemptReviewModal
          attempt={reviewing.attempt}
          quiz={reviewing.quiz}
          pool={subjectPool}
          onClose={() => setReviewing(null)}
        />
      )}

      {running && (
        <QuizRunner
          quiz={running}
          bank={(() => {
            const scope = quizScopeTopicIds(running);
            return scope == null ? subjectPool : subjectPool.filter((q) => scope.includes(q.topic_id));
          })()}
          topics={topics}
          onClose={() => { setRunning(null); refresh(); }}
        />
      )}
    </div>
  );
}

// ── quiz card + creation ─────────────────────────────────────────────────────

function NewQuizButton({ subjectId, topics, defaultTopicIds, bankSize, onCreated, onError, exam = false }: {
  subjectId: number | null; topics: QuizTopic[]; defaultTopicIds: number[]; bankSize: number; onCreated: () => void; onError: (e: unknown) => void; exam?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [count, setCount] = useState(exam ? '20' : '10');
  const [pass, setPass] = useState('60');
  const [timeLimit, setTimeLimit] = useState(exam ? '60' : '');
  const [shuffleQ, setShuffleQ] = useState(true);
  const [shuffleO, setShuffleO] = useState(true);
  const [showAnswers, setShowAnswers] = useState(exam ? 'NEVER' : 'END_OF_QUIZ');
  const [picked, setPicked] = useState<Set<number>>(new Set(defaultTopicIds));
  const scopeMissing = subjectId == null;
  const allPicked = picked.size === topics.length && topics.length > 0;

  const openForm = () => {
    setPicked(new Set(defaultTopicIds.length > 0 ? defaultTopicIds : topics.map((t) => t.id)));
    setOpen(true);
  };

  const create = () => {
    if (scopeMissing || !name.trim() || picked.size === 0) return;
    void createQuiz({
      kind: exam ? 'exam' : 'quiz',
      // Whole-subject scope stays subject-scoped (future topics join in);
      // a subset pins to exactly the chosen topics.
      ...(allPicked ? { subjectId: subjectId ?? undefined } : { topicIds: [...picked] }),
      name: name.trim(),
      description: description.trim() || undefined,
      questionCount: Math.max(1, parseInt(count, 10) || 10),
      passingScorePercent: Math.min(100, Math.max(0, parseInt(pass, 10) || 60)),
      timeLimitMinutes: timeLimit.trim() ? Math.max(1, parseInt(timeLimit, 10) || 0) : undefined,
      shuffleQuestions: shuffleQ,
      shuffleOptions: shuffleO,
      showAnswersAfter: showAnswers,
    }).then(() => { setOpen(false); setName(''); onCreated(); }).catch(onError);
  };

  const input = 'g-field g-field-sm';
  return (
    <div className="relative">
      <button onClick={() => (open ? setOpen(false) : openForm())} disabled={scopeMissing} className="g-btn g-btn-sm g-btn-pri">
        {exam ? '＋ Exam' : '＋ Quiz'}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full mt-1 z-50 w-80 g-card g-corners shadow-2xl p-4 space-y-2.5">
            <div className="g-stitle !text-[11px]">{exam ? 'New exam — draws across every topic' : 'New quiz — draws from this topic'}</div>
            <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={exam ? 'e.g. May mock — full syllabus' : 'Quiz name…'} className={input} />
            <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Description (optional)" className={input} />
            <div>
              <div className="flex items-center justify-between mb-1">
                <span className="text-[10px] text-subtext-0">Draws from {allPicked ? 'the whole subject' : `${picked.size} topic${picked.size === 1 ? '' : 's'}`}</span>
                <button
                  onClick={() => setPicked(allPicked ? new Set() : new Set(topics.map((t) => t.id)))}
                  className="text-[10px] text-gold hover:underline"
                >
                  {allPicked ? 'none' : 'all topics'}
                </button>
              </div>
              <div className="flex flex-wrap gap-1 max-h-24 overflow-y-auto">
                {topics.map((t) => {
                  const on = picked.has(t.id);
                  return (
                    <button
                      key={t.id}
                      onClick={() => setPicked((p) => { const n = new Set(p); if (on) n.delete(t.id); else n.add(t.id); return n; })}
                      className={`px-2 py-0.5 text-[11px] rounded-full border truncate max-w-36 ${
                        on ? 'bg-gilt-b border-gilt-a text-gold' : 'border-surface-1 text-subtext-0 hover:text-text'
                      }`}
                    >
                      {t.name}
                    </button>
                  );
                })}
              </div>
              {picked.size === 0 && <p className="text-[10px] text-warning mt-1">Pick at least one topic.</p>}
            </div>
            <div className="flex gap-2">
              <label className="flex-1">
                <span className="text-[10px] text-subtext-0">Questions drawn</span>
                <input value={count} onChange={(e) => setCount(e.target.value)} className={input} />
              </label>
              <label className="flex-1">
                <span className="text-[10px] text-subtext-0">Pass ≥ %</span>
                <input value={pass} onChange={(e) => setPass(e.target.value)} className={input} />
              </label>
              <label className="flex-1">
                <span className="text-[10px] text-subtext-0">Time (min)</span>
                <input value={timeLimit} onChange={(e) => setTimeLimit(e.target.value)} placeholder="—" className={input} />
              </label>
            </div>
            <label className="block">
              <span className="text-[10px] text-subtext-0">Show answers</span>
              <select value={showAnswers} onChange={(e) => setShowAnswers(e.target.value)} className={input}>
                <option value="END_OF_QUIZ">After submitting (review mode)</option>
                <option value="NEVER">Never (score only — exam conditions)</option>
              </select>
            </label>
            <div className="flex gap-4">
              <label className="flex items-center gap-1.5 text-xs text-subtext-1">
                <input type="checkbox" checked={shuffleQ} onChange={(e) => setShuffleQ(e.target.checked)} className="accent-[var(--color-primary)]" />
                Shuffle questions
              </label>
              <label className="flex items-center gap-1.5 text-xs text-subtext-1">
                <input type="checkbox" checked={shuffleO} onChange={(e) => setShuffleO(e.target.checked)} className="accent-[var(--color-primary)]" />
                Shuffle options
              </label>
            </div>
            {bankSize === 0 && <p className="text-[11px] text-warning">The bank has no runnable questions yet.</p>}
            <div className="flex justify-end gap-2 pt-1">
              <button onClick={() => setOpen(false)} className="g-btn g-btn-sm g-btn-ghost">Cancel</button>
              <button onClick={create} disabled={!name.trim() || picked.size === 0} className="g-btn g-btn-sm g-btn-pri">
                Create {exam ? 'exam' : 'quiz'}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function QuizCard({ quiz, topics, refreshKey, onRun, onReview, onDeleted, onError }: {
  quiz: QuizDef; topics: QuizTopic[]; refreshKey: number; onRun: () => void; onReview: (a: QuizAttempt) => void; onDeleted: () => void; onError: (e: unknown) => void;
}) {
  const scope = quizScopeTopicIds(quiz);
  const scopeNames = scope == null ? null : scope.map((id) => topics.find((t) => t.id === id)?.name ?? `#${id}`);
  const [attempts, setAttempts] = useState<QuizAttempt[] | null>(null);
  const [open, setOpen] = useState(false);
  // Fresh on every open AND after any run (refreshKey bumps) — a stale list
  // hid the attempt you just made.
  useEffect(() => {
    if (open) getQuizAttempts(quiz.id).then(setAttempts).catch(() => setAttempts([]));
  }, [open, quiz.id, refreshKey]);
  const best = useMemo(() => (attempts ?? []).reduce((m, a) => Math.max(m, a.percentage), 0), [attempts]);
  return (
    <div className="g-card px-4 py-3">
      <div className="flex items-center gap-2 cursor-pointer" onClick={() => setOpen((v) => !v)}>
        <div className="min-w-0 flex-1">
          <div className="text-sm text-text truncate">{quiz.name}</div>
          <div className="text-[11px] text-subtext-0">
            {quiz.question_count} drawn · pass ≥ {quiz.passing_score_percent}%{quiz.time_limit_minutes != null ? ` · ⏱ ${quiz.time_limit_minutes}m` : ''}
          </div>
          <div className="flex flex-wrap gap-1 mt-1">
            {scopeNames == null ? (
              <span className="px-1.5 py-0.5 text-[10px] rounded-full bg-warning/10 text-warning border border-warning/30">whole subject</span>
            ) : (
              scopeNames.slice(0, 4).map((n) => (
                <span key={n} className="px-1.5 py-0.5 text-[10px] rounded-full bg-surface-0 text-subtext-1 truncate max-w-36">{n}</span>
              ))
            )}
            {scopeNames != null && scopeNames.length > 4 && (
              <span className="text-[10px] text-subtext-0">+{scopeNames.length - 4} more</span>
            )}
          </div>
        </div>
        <button onClick={(e) => { e.stopPropagation(); onRun(); }} className="g-btn g-btn-sm g-btn-pri shrink-0">▶ Take</button>
        <button
          onClick={(e) => {
            e.stopPropagation();
            void confirmDialog(`Delete quiz “${quiz.name}” (attempt history goes with it)?`).then((ok) => {
              if (ok) void deleteQuiz(quiz.id).then(onDeleted).catch(onError);
            });
          }}
          className="px-2 py-1 text-xs text-subtext-0 hover:text-error shrink-0"
        >
          🗑
        </button>
        <span className="text-subtext-0 text-xs shrink-0">{open ? '▾' : '▸'}</span>
      </div>
      {open && (
        <div className="mt-2 pt-2 border-t border-gilt-b space-y-1">
          {(attempts ?? []).length === 0 ? (
            <p className="text-[11px] text-subtext-0 italic">No attempts yet.</p>
          ) : (
            <>
              <p className="text-[11px] text-subtext-0">Best: {Math.round(best)}%</p>
              {(attempts ?? []).slice(0, 8).map((a) => (
                <button
                  key={a.id}
                  onClick={() => onReview(a)}
                  title="Review this attempt — your answers question by question"
                  className="w-full flex items-center gap-2 text-[11px] px-1.5 py-1 rounded-lg hover:bg-surface-0 text-left"
                >
                  <span className={`px-1.5 py-0.5 rounded font-bold ${a.percentage >= quiz.passing_score_percent ? 'bg-success/15 text-success' : 'bg-error/15 text-error'}`}>
                    {Math.round(a.percentage)}%
                  </span>
                  <span className="text-subtext-1">{a.score}/{a.max_score} pts</span>
                  {a.time_taken_seconds != null && <span className="text-subtext-0">· {Math.floor(a.time_taken_seconds / 60)}m {a.time_taken_seconds % 60}s</span>}
                  <span className="ml-auto text-subtext-0">{a.started_at.slice(5, 16)}</span>
                  <span className="text-gold">review →</span>
                </button>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ── question editor ──────────────────────────────────────────────────────────

function QuestionEditor({ topicId, topics, subjectId, question, onClose, onSaved, onError }: {
  /** The topic selected in the rail — a NEW question lands there unless the
   * editor's Topic field says otherwise. Null when the subject has no topics
   * yet: the field then asks for one (or creates it inline). */
  topicId: number | null;
  topics: QuizTopic[];
  subjectId: number;
  question: QuizQuestion | null;
  onClose: () => void;
  /** Saved (created / updated / moved). `topicId` is where it now lives, so the
   * tab can follow it. */
  onSaved: (topicId: number) => void;
  onError: (e: unknown) => void;
}) {
  const [type, setType] = useState<QuizQuestionType>(question?.question_type ?? 'SINGLE_CHOICE');
  const [text, setText] = useState(question?.question_text ?? '');
  const [explanation, setExplanation] = useState(question?.explanation ?? '');
  const [difficulty, setDifficulty] = useState<QuizDifficulty>(question?.difficulty ?? 'MEDIUM');
  const [points, setPoints] = useState(String(question?.points ?? 1));
  const [source, setSource] = useState(question?.source ?? '');
  // Topic: an existing question's own; a new one inherits the rail selection.
  const [topic, setTopic] = useState<number | null>(question?.topic_id ?? topicId);
  const [newTopicName, setNewTopicName] = useState<string | null>(null);
  const data = question ? parseData(question) : {};
  const [options, setOptions] = useState<Option[]>((data.options as Option[]) ?? [{ optionText: '', isCorrect: true }, { optionText: '', isCorrect: false }]);
  // FILL_BLANK: the alternates are edited as ONE RAW STRING per blank and parsed
  // on save. Parsing on every keystroke (split → trim → drop empties → re-join)
  // ate the comma the moment you typed it — "foo," became "foo" — so a second
  // alternate could never be entered. Raw while typing, structured when saved.
  const [blanks, setBlanks] = useState<{ correctAnswer: string; altRaw: string }[]>(
    ((data.blanks as Blank[]) ?? [{ correctAnswer: '' }]).map((b) => ({ correctAnswer: b.correctAnswer ?? '', altRaw: alternates(b).join(', ') })),
  );
  const [ddBlanks, setDdBlanks] = useState<{ correctAnswer: string; optionsRaw: string }[]>(
    ((data.blanks as DropdownBlank[]) ?? [{ options: [], correctAnswer: '' }]).map((b) => ({ correctAnswer: b.correctAnswer ?? '', optionsRaw: (b.options ?? []).join(', ') })),
  );
  const [numAnswer, setNumAnswer] = useState(String((data.correctAnswer as number) ?? ''));
  const [numTol, setNumTol] = useState(String((data.tolerance as number) ?? 0));
  const [numUnit, setNumUnit] = useState(String(data.unit ?? ''));
  const [pairs, setPairs] = useState<MatchPair[]>((data.matches as MatchPair[]) ?? [{ leftItem: '', rightItem: '' }, { leftItem: '', rightItem: '' }]);
  // ORDERING is edited in the CORRECT order; positions are assigned on save.
  const [items, setItems] = useState<string[]>(orderedItems((data.items as OrderItem[]) ?? []).map((i) => i.itemText).concat((data.items as OrderItem[])?.length ? [] : ['', '']));
  const [variables, setVariables] = useState<{ name: string; value: string; unit: string }[]>(
    ((data.variables as CalcVariable[]) ?? []).map((v) => ({ name: v.name ?? '', value: String(v.value ?? ''), unit: v.unit ?? '' })),
  );
  const [calcAnswers, setCalcAnswers] = useState<{ label: string; correctValue: string; tolerance: string; unit: string }[]>(
    ((data.answers as CalcAnswer[]) ?? [{ label: '', correctValue: 0 }]).map((a) => ({ label: a.label ?? '', correctValue: String(a.correctValue ?? ''), tolerance: String(a.tolerance ?? 0), unit: a.unit ?? '' })),
  );
  const [steps, setSteps] = useState<string>(((data.solutionSteps as string[]) ?? []).join('\n'));
  const [imagePath, setImagePath] = useState(String(data.imagePath ?? ''));
  const [imageAlt, setImageAlt] = useState(String(data.imageAltText ?? ''));
  const [showJson, setShowJson] = useState(false);
  const [rawJson, setRawJson] = useState(question?.data_json ?? '{}');
  const splitList = (raw: string) => raw.split(',').map((x) => x.trim()).filter(Boolean);

  /** The widget's view of the data, laid over whatever else the record held —
   * unit, formula, decimalPlaces, orderDirection… survive untouched. */
  const buildData = (): string => {
    if (showJson) return rawJson;
    const num = (v: string, dflt = 0) => { const n = parseFloat(v); return isNaN(n) ? dflt : n; };
    switch (type) {
      case 'SINGLE_CHOICE':
      case 'MULTIPLE_CHOICE':
        return JSON.stringify({ ...data, options: options.filter((o) => o.optionText.trim()) });
      case 'IMAGE_IDENTIFICATION':
        return JSON.stringify({ ...data, imagePath: imagePath.trim(), imageAltText: imageAlt.trim() || undefined, options: options.filter((o) => o.optionText.trim()) });
      case 'FILL_BLANK':
        return JSON.stringify({
          ...data,
          blanks: blanks.filter((b) => b.correctAnswer.trim()).map((b) => ({ correctAnswer: b.correctAnswer.trim(), acceptableAnswers: splitList(b.altRaw) })),
        });
      case 'FILL_BLANK_MULTIPLE':
        return JSON.stringify({
          ...data,
          blanks: ddBlanks
            .filter((b) => b.correctAnswer.trim())
            .map((b, i) => {
              const opts = splitList(b.optionsRaw);
              const correct = b.correctAnswer.trim();
              // The right answer must be pickable.
              if (!opts.some((o) => norm(o) === norm(correct))) opts.push(correct);
              return { index: i, options: opts, correctAnswer: correct };
            }),
        });
      case 'NUMERIC_INPUT':
        return JSON.stringify({ ...data, correctAnswer: num(numAnswer), tolerance: num(numTol), toleranceType: (data.toleranceType as string) ?? 'ABSOLUTE', unit: numUnit.trim() || undefined });
      case 'MATCHING':
        return JSON.stringify({ ...data, matches: pairs.filter((p) => p.leftItem.trim() && p.rightItem.trim()).map((p) => ({ leftItem: p.leftItem.trim(), rightItem: p.rightItem.trim() })), allowReuseRight: (data.allowReuseRight as boolean) ?? false });
      case 'ORDERING':
        return JSON.stringify({ ...data, items: items.filter((t) => t.trim()).map((t, i) => ({ itemText: t.trim(), correctPosition: i + 1 })), orderDirection: (data.orderDirection as string) ?? 'CUSTOM' });
      case 'CALCULATION':
        return JSON.stringify({
          ...data,
          variables: variables.filter((v) => v.name.trim()).map((v) => ({ name: v.name.trim(), value: num(v.value), unit: v.unit.trim() })),
          answers: calcAnswers.filter((a) => a.label.trim() || a.correctValue.trim()).map((a) => ({ label: a.label.trim() || 'Answer', correctValue: num(a.correctValue), tolerance: num(a.tolerance), unit: a.unit.trim() })),
          solutionSteps: steps.split('\n').map((x) => x.trim()).filter(Boolean),
        });
      default:
        return rawJson;
    }
  };

  const save = () => {
    const dataJson = buildData();
    const base = {
      questionText: text, explanation: explanation.trim() || undefined,
      difficulty, points: Math.max(1, parseInt(points, 10) || 1), source: source.trim() || undefined, dataJson,
    };
    if (topic == null) return;
    const dest = topic;
    const p = question
      ? updateQuizQuestion(question.id, base).then(async () => {
          // A changed Topic field = a move (the same primitive as the context menu).
          if (dest !== question.topic_id) await moveQuizQuestions([question.id], dest);
        })
      : createQuizQuestion({ topicId: dest, questionType: type, ...base });
    void p.then(() => onSaved(dest)).catch(onError);
  };

  const createTopicInline = async () => {
    const name = (newTopicName ?? '').trim();
    if (!name) return;
    try {
      const t = await createQuizTopic(subjectId, name);
      setTopic(t.id);
      setNewTopicName(null);
      onTopicsChanged();
    } catch (e) {
      onError(e);
    }
  };
  // The tab re-fetches topics on the quiz pulse, but a just-created topic must
  // appear in THIS select immediately — so we keep a local overlay too.
  const [localTopics, setLocalTopics] = useState<QuizTopic[]>([]);
  const onTopicsChanged = () => { void getQuizTopics(subjectId).then(setLocalTopics).catch(onError); };
  const allTopics = localTopics.length ? localTopics : topics;

  const input = 'g-field g-field-sm';
  const small = `${input} text-xs`;
  const RowX = ({ onClick }: { onClick: () => void }) => (
    <button onClick={onClick} className="text-subtext-0 hover:text-error text-xs shrink-0" title="Remove">✕</button>
  );

  const choiceEditor = (multi: boolean) => (
    <div className="space-y-1.5">
      <span className="text-[11px] text-subtext-0">Options — tick the correct one{multi ? 's' : ''}</span>
      {options.map((o, i) => (
        <div key={i} className="flex items-center gap-2">
          <input
            type={multi ? 'checkbox' : 'radio'}
            name="correct"
            checked={o.isCorrect}
            onChange={(e) =>
              setOptions((os) => os.map((x, j) => (!multi ? { ...x, isCorrect: j === i } : j === i ? { ...x, isCorrect: e.target.checked } : x)))
            }
            className="accent-[var(--color-primary)]"
          />
          <input value={o.optionText} onChange={(e) => setOptions((os) => os.map((x, j) => (j === i ? { ...x, optionText: e.target.value } : x)))} placeholder={`Option ${i + 1}`} className={input} />
          <RowX onClick={() => setOptions((os) => os.filter((_, j) => j !== i))} />
        </div>
      ))}
      <button onClick={() => setOptions((os) => [...os, { optionText: '', isCorrect: false }])} className="g-lnk !min-h-0 !px-0 !text-xs !text-gold">＋ option</button>
    </div>
  );

  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="g-bar justify-between px-4 h-12 shrink-0">
        <span className="g-stitle">{question ? 'Edit question' : 'New question'}</span>
        <button onClick={onClose} className="g-iconbtn" title="Close">✕</button>
      </div>
      <ScrollArea className="flex-1" contentClassName="p-4 space-y-3">
        <div className="flex gap-2">
          {!question && (
            <label className="block flex-1 min-w-0">
              <span className="text-[11px] text-subtext-0">Type</span>
              <select value={type} onChange={(e) => setType(e.target.value as QuizQuestionType)} className={input}>
                {(Object.keys(TYPE_LABEL) as QuizQuestionType[]).map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
              </select>
            </label>
          )}
          <label className="block flex-1 min-w-0">
            <span className="text-[11px] text-subtext-0">Topic</span>
            {newTopicName === null ? (
              <select
                value={topic ?? ''}
                onChange={(e) => {
                  if (e.target.value === '__new__') setNewTopicName('');
                  else if (e.target.value) setTopic(Number(e.target.value));
                }}
                className={input}
              >
                {topic == null && <option value="">— pick a topic —</option>}
                {allTopics.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                <option value="__new__">＋ New topic…</option>
              </select>
            ) : (
              <div className="flex gap-1.5">
                <input
                  autoFocus
                  value={newTopicName}
                  onChange={(e) => setNewTopicName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') void createTopicInline(); if (e.key === 'Escape') setNewTopicName(null); }}
                  placeholder="Topic name"
                  className={input}
                />
                <button onClick={() => void createTopicInline()} disabled={!newTopicName.trim()} className="g-btn g-btn-sm g-btn-pri">Add</button>
                <button onClick={() => setNewTopicName(null)} className="text-subtext-0 hover:text-text text-xs">✕</button>
              </div>
            )}
          </label>
        </div>
        <label className="block">
          <span className="text-[11px] text-subtext-0">Question</span>
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} className={input} />
        </label>

        {showJson ? (
          <label className="block">
            <span className="text-[11px] text-subtext-0">Structure (QuizForge JSON)</span>
            <textarea value={rawJson} onChange={(e) => setRawJson(e.target.value)} rows={10} className={`${input} font-mono text-xs`} />
          </label>
        ) : (
          <>
            {type === 'SINGLE_CHOICE' && choiceEditor(false)}
            {type === 'MULTIPLE_CHOICE' && choiceEditor(true)}
            {type === 'IMAGE_IDENTIFICATION' && (
              <div className="space-y-2">
                <label className="block">
                  <span className="text-[11px] text-subtext-0">Image URL (https://… or a data: URL)</span>
                  <input value={imagePath} onChange={(e) => setImagePath(e.target.value)} placeholder="https://…/diagram.png" className={input} />
                </label>
                {imagePath.trim() && <img src={imagePath.trim()} alt={imageAlt} className="max-h-40 rounded-lg border border-surface-0 object-contain" />}
                <label className="block">
                  <span className="text-[11px] text-subtext-0">Alt text (what the picture shows, for screen readers)</span>
                  <input value={imageAlt} onChange={(e) => setImageAlt(e.target.value)} className={input} />
                </label>
                {choiceEditor(false)}
              </div>
            )}

            {type === 'FILL_BLANK' && (
              <div className="space-y-1.5">
                <span className="text-[11px] text-subtext-0">Blanks — the answer, then any alternates that also count (comma-separated)</span>
                {blanks.map((b, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <input value={b.correctAnswer} onChange={(e) => setBlanks((bs) => bs.map((x, j) => (j === i ? { ...x, correctAnswer: e.target.value } : x)))} placeholder={`Blank ${i + 1} answer`} className={input} />
                    <input value={b.altRaw} onChange={(e) => setBlanks((bs) => bs.map((x, j) => (j === i ? { ...x, altRaw: e.target.value } : x)))} placeholder="alternates, comma-separated" className={input} />
                    <RowX onClick={() => setBlanks((bs) => bs.filter((_, j) => j !== i))} />
                  </div>
                ))}
                <button onClick={() => setBlanks((bs) => [...bs, { correctAnswer: '', altRaw: '' }])} className="g-lnk !min-h-0 !px-0 !text-xs !text-gold">＋ blank</button>
              </div>
            )}

            {type === 'FILL_BLANK_MULTIPLE' && (
              <div className="space-y-1.5">
                <span className="text-[11px] text-subtext-0">Dropdown blanks — the choices offered (comma-separated) and which one is right</span>
                {ddBlanks.map((b, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <input value={b.optionsRaw} onChange={(e) => setDdBlanks((bs) => bs.map((x, j) => (j === i ? { ...x, optionsRaw: e.target.value } : x)))} placeholder="choice, choice, choice" className={input} />
                    <input value={b.correctAnswer} onChange={(e) => setDdBlanks((bs) => bs.map((x, j) => (j === i ? { ...x, correctAnswer: e.target.value } : x)))} placeholder="correct choice" className={input} />
                    <RowX onClick={() => setDdBlanks((bs) => bs.filter((_, j) => j !== i))} />
                  </div>
                ))}
                <button onClick={() => setDdBlanks((bs) => [...bs, { correctAnswer: '', optionsRaw: '' }])} className="g-lnk !min-h-0 !px-0 !text-xs !text-gold">＋ blank</button>
              </div>
            )}

            {type === 'NUMERIC_INPUT' && (
              <div className="flex gap-2">
                <label className="block flex-1">
                  <span className="text-[11px] text-subtext-0">Correct answer</span>
                  <input value={numAnswer} onChange={(e) => setNumAnswer(e.target.value)} className={input} />
                </label>
                <label className="block w-24">
                  <span className="text-[11px] text-subtext-0">± tolerance</span>
                  <input value={numTol} onChange={(e) => setNumTol(e.target.value)} className={input} />
                </label>
                <label className="block w-20">
                  <span className="text-[11px] text-subtext-0">Unit</span>
                  <input value={numUnit} onChange={(e) => setNumUnit(e.target.value)} placeholder="%" className={input} />
                </label>
              </div>
            )}

            {type === 'MATCHING' && (
              <div className="space-y-1.5">
                <span className="text-[11px] text-subtext-0">Pairs — each left item with the right item it matches (the runner shuffles the right side)</span>
                {pairs.map((p, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <input value={p.leftItem} onChange={(e) => setPairs((ps) => ps.map((x, j) => (j === i ? { ...x, leftItem: e.target.value } : x)))} placeholder="Left" className={input} />
                    <span className="text-subtext-0 text-xs shrink-0">↔</span>
                    <input value={p.rightItem} onChange={(e) => setPairs((ps) => ps.map((x, j) => (j === i ? { ...x, rightItem: e.target.value } : x)))} placeholder="Right" className={input} />
                    <RowX onClick={() => setPairs((ps) => ps.filter((_, j) => j !== i))} />
                  </div>
                ))}
                <button onClick={() => setPairs((ps) => [...ps, { leftItem: '', rightItem: '' }])} className="g-lnk !min-h-0 !px-0 !text-xs !text-gold">＋ pair</button>
              </div>
            )}

            {type === 'ORDERING' && (
              <div className="space-y-1.5">
                <span className="text-[11px] text-subtext-0">Items in the CORRECT order (the runner shuffles them)</span>
                {items.map((t, i) => (
                  <div key={i} className="flex items-center gap-1.5">
                    <span className="text-[11px] text-subtext-0 w-4 shrink-0">{i + 1}.</span>
                    <input value={t} onChange={(e) => setItems((is) => is.map((x, j) => (j === i ? e.target.value : x)))} placeholder={`Step ${i + 1}`} className={input} />
                    <button onClick={() => setItems((is) => { if (i === 0) return is; const c = [...is]; [c[i - 1], c[i]] = [c[i], c[i - 1]]; return c; })} disabled={i === 0} className="text-subtext-0 hover:text-text text-xs disabled:opacity-30">↑</button>
                    <button onClick={() => setItems((is) => { if (i === is.length - 1) return is; const c = [...is]; [c[i + 1], c[i]] = [c[i], c[i + 1]]; return c; })} disabled={i === items.length - 1} className="text-subtext-0 hover:text-text text-xs disabled:opacity-30">↓</button>
                    <RowX onClick={() => setItems((is) => is.filter((_, j) => j !== i))} />
                  </div>
                ))}
                <button onClick={() => setItems((is) => [...is, ''])} className="g-lnk !min-h-0 !px-0 !text-xs !text-gold">＋ item</button>
              </div>
            )}

            {type === 'CALCULATION' && (
              <div className="space-y-3">
                <div className="space-y-1.5">
                  <span className="text-[11px] text-subtext-0">Given values (shown to the person)</span>
                  {variables.map((v, i) => (
                    <div key={i} className="flex items-center gap-1.5">
                      <input value={v.name} onChange={(e) => setVariables((vs) => vs.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} placeholder="name" className={small} />
                      <span className="text-subtext-0 text-xs">=</span>
                      <input value={v.value} onChange={(e) => setVariables((vs) => vs.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} placeholder="value" className={`${small} w-24`} />
                      <input value={v.unit} onChange={(e) => setVariables((vs) => vs.map((x, j) => (j === i ? { ...x, unit: e.target.value } : x)))} placeholder="unit" className={`${small} w-16`} />
                      <RowX onClick={() => setVariables((vs) => vs.filter((_, j) => j !== i))} />
                    </div>
                  ))}
                  <button onClick={() => setVariables((vs) => [...vs, { name: '', value: '', unit: '' }])} className="g-lnk !min-h-0 !px-0 !text-xs !text-gold">＋ given</button>
                </div>
                <div className="space-y-1.5">
                  <span className="text-[11px] text-subtext-0">Answers to compute (each is graded, ± tolerance)</span>
                  {calcAnswers.map((a, i) => (
                    <div key={i} className="flex items-center gap-1.5">
                      <input value={a.label} onChange={(e) => setCalcAnswers((as) => as.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} placeholder="label" className={small} />
                      <input value={a.correctValue} onChange={(e) => setCalcAnswers((as) => as.map((x, j) => (j === i ? { ...x, correctValue: e.target.value } : x)))} placeholder="value" className={`${small} w-24`} />
                      <input value={a.tolerance} onChange={(e) => setCalcAnswers((as) => as.map((x, j) => (j === i ? { ...x, tolerance: e.target.value } : x)))} placeholder="±" className={`${small} w-14`} title="tolerance" />
                      <input value={a.unit} onChange={(e) => setCalcAnswers((as) => as.map((x, j) => (j === i ? { ...x, unit: e.target.value } : x)))} placeholder="unit" className={`${small} w-16`} />
                      <RowX onClick={() => setCalcAnswers((as) => as.filter((_, j) => j !== i))} />
                    </div>
                  ))}
                  <button onClick={() => setCalcAnswers((as) => [...as, { label: '', correctValue: '', tolerance: '0', unit: '' }])} className="g-lnk !min-h-0 !px-0 !text-xs !text-gold">＋ answer</button>
                </div>
                <label className="block">
                  <span className="text-[11px] text-subtext-0">Solution steps (one per line, shown with the explanation)</span>
                  <textarea value={steps} onChange={(e) => setSteps(e.target.value)} rows={3} className={input} />
                </label>
              </div>
            )}
          </>
        )}

        <label className="block">
          <span className="text-[11px] text-subtext-0">Explanation (shown after answering)</span>
          <textarea value={explanation} onChange={(e) => setExplanation(e.target.value)} rows={2} className={input} />
        </label>
        <div className="flex gap-2">
          <label className="block flex-1">
            <span className="text-[11px] text-subtext-0">Difficulty</span>
            <select value={difficulty} onChange={(e) => setDifficulty(e.target.value as QuizDifficulty)} className={input}>
              <option value="EASY">Easy</option>
              <option value="MEDIUM">Medium</option>
              <option value="HARD">Hard</option>
            </select>
          </label>
          <label className="block w-20">
            <span className="text-[11px] text-subtext-0">Points</span>
            <input value={points} onChange={(e) => setPoints(e.target.value)} className={input} />
          </label>
        </div>
        <label className="block">
          <span className="text-[11px] text-subtext-0">Source (lecture, page…)</span>
          <input value={source} onChange={(e) => setSource(e.target.value)} className={input} />
        </label>
        <button
          onClick={() => { if (!showJson) setRawJson(buildData()); setShowJson((v) => !v); }}
          className="text-[11px] text-subtext-0 hover:text-text"
          title="The raw QuizForge structure — for fields the widgets don't expose"
        >
          {showJson ? '‹ Back to the form' : 'Edit as JSON ›'}
        </button>

        <div className="flex gap-2 pt-3 border-t border-gilt-b">
          <button onClick={save} disabled={!text.trim() || topic == null} title={topic == null ? 'Pick a topic first' : undefined} className="g-btn g-btn-pri flex-1">
            {question ? 'Save' : 'Add question'}
          </button>
          {question && (
            <button
              onClick={() => {
                void confirmDialog('Delete this question?').then((ok) => {
                  if (ok) void deleteQuizQuestion(question.id).then(() => onSaved(question.topic_id)).catch(onError);
                });
              }}
              className="g-btn g-btn-danger"
            >
              Delete
            </button>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

// ── analytics + leaderboard ──────────────────────────────────────────────────

function SubjectAnalytics({ projectId, subjectId, quizzes, exams, pool, topics, refreshKey }: {
  projectId: number; subjectId: number; quizzes: QuizDef[]; exams: QuizDef[]; pool: QuizQuestion[]; topics: QuizTopic[]; refreshKey: number;
}) {
  const [attempts, setAttempts] = useState<QuizAttempt[] | null>(null);
  const [board, setBoard] = useState<QuizLeaderboardRow[]>([]);
  const [optedIn, setOptedIn] = useState<boolean | null>(null);
  const userId = Number(localStorage.getItem('currentUserId')) || 0;

  useEffect(() => {
    let stop = false;
    const all = [...quizzes, ...exams];
    Promise.all(all.map((z) => getQuizAttempts(z.id).catch(() => [] as QuizAttempt[]))).then((lists) => {
      if (!stop) setAttempts(lists.flat().sort((a, b) => a.started_at.localeCompare(b.started_at)));
    });
    getQuizLeaderboard(subjectId).then((b) => { if (!stop) setBoard(b); }).catch(() => {});
    if (userId) getQuizLeaderboardOptin(projectId, userId).then((v) => { if (!stop) setOptedIn(v); }).catch(() => setOptedIn(false));
    return () => { stop = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subjectId, quizzes.length, exams.length, refreshKey]);

  const mine = (attempts ?? []).filter((a) => a.user_id === userId || a.user_id == null);
  const best = mine.reduce((m, a) => Math.max(m, a.percentage), 0);
  const avg = mine.length ? mine.reduce((s, a) => s + a.percentage, 0) / mine.length : 0;
  const totalTime = mine.reduce((s, a) => s + (a.time_taken_seconds ?? 0), 0);

  // Per-topic accuracy from graded answers ({qid: {correct, earned}}).
  const topicAcc = (() => {
    const qTopic = new Map(pool.map((q) => [q.id, q.topic_id]));
    const acc = new Map<number, { right: number; total: number }>();
    for (const a of mine) {
      try {
        const answers = JSON.parse(a.answers_json) as Record<string, { correct?: boolean }>;
        for (const [qid, r] of Object.entries(answers)) {
          const tid = qTopic.get(Number(qid));
          if (tid == null) continue;
          const cur = acc.get(tid) ?? { right: 0, total: 0 };
          cur.total += 1;
          if (r.correct) cur.right += 1;
          acc.set(tid, cur);
        }
      } catch { /* legacy attempt */ }
    }
    return [...acc.entries()]
      .map(([tid, v]) => ({ name: topics.find((t) => t.id === tid)?.name ?? `topic #${tid}`, ...v }))
      .sort((a, b) => a.right / Math.max(1, a.total) - b.right / Math.max(1, b.total));
  })();

  const toggleOptin = () => {
    if (!userId || optedIn == null) return;
    const next = !optedIn;
    setOptedIn(next);
    void setQuizLeaderboardOptin(projectId, userId, next)
      .then(() => getQuizLeaderboard(subjectId).then(setBoard))
      .catch(() => setOptedIn(!next));
  };

  const card = 'g-card px-5 py-4';
  if (attempts == null) return <p className="text-sm text-subtext-0">Crunching attempts…</p>;
  return (
    <div className="space-y-4 max-w-3xl">
      {/* KPIs */}
      <div className="grid grid-cols-4 gap-3">
        {([
          ['Attempts', String(mine.length)],
          ['Best', `${Math.round(best)}%`],
          ['Average', `${Math.round(avg)}%`],
          ['Time in quizzes', `${Math.floor(totalTime / 60)}m`],
        ] as const).map(([label, value]) => (
          <div key={label} className={`${card} text-center`}>
            <div className="font-deco text-3xl font-light text-text">{value}</div>
            <div className="text-[11px] text-subtext-0">{label}</div>
          </div>
        ))}
      </div>

      {/* score trend — recharts, like the original QuizForge AnalyticsPage:
          SVG with computed coordinates (ResponsiveContainer measures in JS),
          immune to the WKWebView %-height flexbox quirks that ate two
          hand-rolled attempts at this chart. */}
      <div className={card}>
        <div className="g-cap mb-3">Score trend (your last {Math.min(20, mine.length)} attempts)</div>
        {mine.length === 0 ? (
          <p className="text-sm text-subtext-0 italic">Take a quiz — the trend starts with attempt one.</p>
        ) : (
          <ResponsiveContainer width="100%" height={240}>
            <LineChart
              data={mine.slice(-20).map((a, i) => ({
                name: `#${mine.length - Math.min(20, mine.length) + i + 1}`,
                date: a.started_at.slice(5, 16),
                score: Math.round(a.percentage),
              }))}
              margin={{ top: 8, right: 12, bottom: 0, left: -18 }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="var(--color-surface-2)" />
              <XAxis dataKey="name" stroke="var(--color-subtext-0)" style={{ fontSize: 11 }} tickLine={false} />
              <YAxis domain={[0, 100]} stroke="var(--color-subtext-0)" style={{ fontSize: 11 }} tickLine={false} />
              <ChartTooltip
                contentStyle={{
                  backgroundColor: 'var(--color-surface-0)',
                  border: '1px solid var(--color-surface-2)',
                  borderRadius: 8,
                  fontSize: 12,
                }}
                labelStyle={{ color: 'var(--color-text)' }}
                formatter={(value) => [`${String(value ?? '')}%`, 'score']}
                labelFormatter={(label, payload) => {
                  const p = Array.isArray(payload) ? payload[0]?.payload as { date?: string } | undefined : undefined;
                  return `${label}${p?.date ? ` · ${p.date}` : ''}`;
                }}
              />
              <ReferenceLine y={60} stroke="var(--color-warning)" strokeDasharray="4 4" />
              <Line
                type="monotone"
                dataKey="score"
                stroke="var(--color-primary)"
                strokeWidth={2}
                dot={{ fill: 'var(--color-primary)', r: 3.5 }}
                activeDot={{ r: 5 }}
              />
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* weakest topics */}
      <div className={card}>
        <div className="g-cap mb-3">Accuracy by topic (weakest first — revise these)</div>
        {topicAcc.length === 0 ? (
          <p className="text-sm text-subtext-0 italic">No graded answers yet.</p>
        ) : (
          <div className="space-y-1.5">
            {topicAcc.map((t) => (
              <div key={t.name} className="flex items-center gap-2">
                <span className="text-[11px] text-subtext-1 w-56 truncate shrink-0">{t.name}</span>
                <div className="flex-1 h-2 bg-surface-1 rounded-full overflow-hidden">
                  <div
                    className={`h-full ${t.right / Math.max(1, t.total) >= 0.6 ? 'bg-success' : 'bg-error'}`}
                    style={{ width: `${(t.right / Math.max(1, t.total)) * 100}%` }}
                  />
                </div>
                <span className="text-[11px] text-subtext-0 w-14 text-right shrink-0">{t.right}/{t.total}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* leaderboard */}
      <div className={card}>
        <div className="flex items-center justify-between mb-2">
          <div className="g-cap">Leaderboard — project members, opt-in</div>
          {userId > 0 && optedIn != null && (
            <label className="flex items-center gap-1.5 text-[11px] text-subtext-1 cursor-pointer">
              <input type="checkbox" checked={optedIn} onChange={toggleOptin} className="accent-[var(--color-primary)]" />
              Show me on the board
            </label>
          )}
        </div>
        {board.length === 0 ? (
          <p className="text-sm text-subtext-0 italic">Nobody has opted in yet — scores stay private until their owner joins the board.</p>
        ) : (
          <div className="space-y-1">
            {board.map((r, i) => (
              <div key={r.user_id} className={`flex items-center gap-2.5 px-2 py-1.5 rounded-lg ${r.user_id === userId ? 'bg-gilt-b shadow-[inset_0_0_0_1px_var(--color-gilt-a)]' : ''}`}>
                <span className="w-6 text-center shrink-0">{i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : <span className="text-[11px] text-subtext-0">{i + 1}</span>}</span>
                <span className="text-sm text-text truncate flex-1">{r.full_name}</span>
                <span className="text-[11px] text-subtext-0 shrink-0">{r.attempts} attempt{r.attempts === 1 ? '' : 's'}</span>
                <span className="text-[11px] text-subtext-1 shrink-0 w-14 text-right">avg {Math.round(r.avg_pct)}%</span>
                <span className="text-sm font-semibold text-text shrink-0 w-14 text-right">{Math.round(r.best_pct)}%</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── attempt review ───────────────────────────────────────────────────────────

/** Read-only review of a PAST attempt, rebuilt from the graded answers_json
 * ({qid: {response, correct, earned}}) and the current bank. Deliberately
 * reveals correct answers regardless of the quiz's show-answers mode — a
 * retrospective is a study tool, not exam conditions. */
function AttemptReviewModal({ attempt, quiz, pool, onClose }: {
  attempt: QuizAttempt; quiz: QuizDef; pool: QuizQuestion[]; onClose: () => void;
}) {
  const answers = useMemo(() => {
    try {
      return JSON.parse(attempt.answers_json) as Record<string, { response?: unknown; correct?: boolean; earned?: number }>;
    } catch {
      return {};
    }
  }, [attempt.answers_json]);
  const byId = useMemo(() => new Map(pool.map((q) => [q.id, q])), [pool]);

  const yourAnswer = (q: QuizQuestion, response: unknown): string => {
    const data = parseData(q);
    switch (q.question_type) {
      case 'SINGLE_CHOICE': {
        const opts = (data.options as Option[]) ?? [];
        return typeof response === 'number' ? opts[response]?.optionText ?? '—' : '— (unanswered)';
      }
      case 'MULTIPLE_CHOICE': {
        const opts = (data.options as Option[]) ?? [];
        const picks = (response as number[]) ?? [];
        return picks.length ? picks.map((i) => opts[i]?.optionText ?? '?').join(' · ') : '— (unanswered)';
      }
      case 'IMAGE_IDENTIFICATION': {
        const opts = (data.options as Option[]) ?? [];
        return typeof response === 'number' ? opts[response]?.optionText ?? '—' : '— (unanswered)';
      }
      case 'FILL_BLANK':
      case 'FILL_BLANK_MULTIPLE':
      case 'CALCULATION': {
        const vals = (response as string[]) ?? [];
        return vals.some((v) => v?.trim()) ? vals.map((v) => v?.trim() || '·').join(' / ') : '— (unanswered)';
      }
      case 'MATCHING': {
        const pairs = (data.matches as MatchPair[]) ?? [];
        const picks = (response as Record<number, number>) ?? {};
        const parts = pairs.map((p, i) => `${p.leftItem} ↔ ${picks[i] != null ? pairs[picks[i]]?.rightItem ?? '?' : '·'}`);
        return Object.keys(picks).length ? parts.join(' · ') : '— (unanswered)';
      }
      case 'ORDERING': {
        const items = (data.items as OrderItem[]) ?? [];
        const order = (response as number[]) ?? [];
        return order.length ? order.map((i) => items[i]?.itemText ?? '?').join(' → ') : '— (unanswered)';
      }
      default:
        return response != null && String(response).trim() !== '' ? String(response) : '— (unanswered)';
    }
  };

  const correctAnswer = (q: QuizQuestion): string => {
    const data = parseData(q);
    switch (q.question_type) {
      case 'SINGLE_CHOICE':
      case 'MULTIPLE_CHOICE': {
        const opts = (data.options as Option[]) ?? [];
        return opts.filter((o) => o.isCorrect).map((o) => o.optionText).join(' · ');
      }
      case 'IMAGE_IDENTIFICATION': {
        const opts = (data.options as Option[]) ?? [];
        return opts.filter((o) => o.isCorrect).map((o) => o.optionText).join(' · ');
      }
      case 'FILL_BLANK':
        return ((data.blanks as Blank[]) ?? []).map((b) => b.correctAnswer).join(' / ');
      case 'FILL_BLANK_MULTIPLE':
        return ((data.blanks as DropdownBlank[]) ?? []).map((b) => b.correctAnswer).join(' / ');
      case 'NUMERIC_INPUT':
        return `${String(data.correctAnswer)}${data.tolerance ? ` (± ${String(data.tolerance)})` : ''}`;
      case 'MATCHING':
        return ((data.matches as MatchPair[]) ?? []).map((p) => `${p.leftItem} ↔ ${p.rightItem}`).join(' · ');
      case 'ORDERING':
        return orderedItems((data.items as OrderItem[]) ?? []).map((i) => i.itemText).join(' → ');
      case 'CALCULATION':
        return ((data.answers as CalcAnswer[]) ?? []).map((a) => `${a.label}: ${a.correctValue}${a.unit ? ` ${a.unit}` : ''}${a.tolerance ? ` (± ${a.tolerance})` : ''}`).join(' · ');
      default:
        return '—';
    }
  };

  const entries = Object.entries(answers);
  const pct = Math.round(attempt.percentage);
  return createPortal(
    <div className="g-scrim z-[120] flex items-center justify-center p-6" onClick={onClose}>
      <div className="g-card g-corners w-full max-w-2xl h-[85vh] overflow-hidden shadow-2xl flex flex-col min-h-0" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-6 py-4 border-b border-gilt-b shrink-0">
          <div>
            <div className="g-stitle">Attempt review — {quiz.name}</div>
            <div className="text-[11px] text-subtext-0">{attempt.started_at.slice(0, 16)} · {attempt.score}/{attempt.max_score} pts</div>
          </div>
          <span className={`text-sm font-bold px-3 py-1 rounded-lg ${pct >= quiz.passing_score_percent ? 'bg-success/15 text-success' : 'bg-error/15 text-error'}`}>
            {pct}%
          </span>
          <button onClick={onClose} className="g-iconbtn ml-3" title="Close">✕</button>
        </div>
        <ScrollArea className="flex-1 min-h-0" contentClassName="p-5 space-y-4">
          {entries.length === 0 && <p className="text-sm text-subtext-0 italic">This attempt predates answer recording.</p>}
          {entries.map(([qid, r], i) => {
            const q = byId.get(Number(qid));
            if (!q) {
              return (
                <div key={qid} className="rounded border border-surface-0 p-3.5 text-sm text-subtext-0 italic">
                  {i + 1}. This question is no longer in the bank.
                </div>
              );
            }
            return (
              <div key={qid} className={`rounded border p-3.5 ${r.correct ? 'border-success/50' : 'border-error/50'}`}>
                <div className="flex items-start gap-2">
                  <span className={`shrink-0 mt-0.5 text-sm ${r.correct ? 'text-success' : 'text-error'}`}>{r.correct ? '✓' : '✗'}</span>
                  <div className="text-sm text-text flex-1">{q.question_text}</div>
                  <span className="text-[10px] text-subtext-0 shrink-0">{r.earned ?? 0}/{q.points} pts</span>
                </div>
                <div className="mt-2 pl-6 space-y-1 text-sm">
                  <div className={r.correct ? 'text-success' : 'text-error'}>
                    <span className="text-[11px] uppercase tracking-wide mr-2 opacity-70">You</span>
                    {yourAnswer(q, r.response)}
                  </div>
                  {!r.correct && (
                    <div className="text-success">
                      <span className="text-[11px] uppercase tracking-wide mr-2 opacity-70">Correct</span>
                      {correctAnswer(q)}
                    </div>
                  )}
                  {q.explanation && <p className="text-xs text-subtext-1 bg-mantle border border-surface-0 rounded-lg px-2.5 py-1.5 mt-1.5">{q.explanation}</p>}
                </div>
              </div>
            );
          })}
        </ScrollArea>
      </div>
    </div>,
    document.body
  );
}

// ── quiz runner ──────────────────────────────────────────────────────────────

function QuizRunner({ quiz, bank, topics, onClose }: { quiz: QuizDef; bank: QuizQuestion[]; topics: QuizTopic[]; onClose: () => void }) {
  const isExam = quiz.kind === 'exam';
  const [drawn] = useState<QuizQuestion[]>(() => {
    const pool = bank.filter((q) => RUNNABLE.includes(q.question_type));
    const want = Math.min(quiz.question_count, pool.length);
    if (isExam) {
      // Exams draw EVENLY across topics (round-robin over shuffled buckets) —
      // a mock covers the syllabus, not whichever lecture is over-represented.
      const buckets = new Map<number, QuizQuestion[]>();
      for (const q of pool) {
        const arr = buckets.get(q.topic_id) ?? [];
        arr.push(q);
        buckets.set(q.topic_id, arr);
      }
      const lists = [...buckets.values()].map((l) => [...l].sort(() => Math.random() - 0.5));
      const out: QuizQuestion[] = [];
      let i = 0;
      while (out.length < want && lists.some((l) => l.length > 0)) {
        const l = lists[i % lists.length];
        if (l.length > 0) out.push(l.pop() as QuizQuestion);
        i++;
      }
      return quiz.shuffle_questions ? out.sort(() => Math.random() - 0.5) : out;
    }
    const shuffled = quiz.shuffle_questions ? [...pool].sort(() => Math.random() - 0.5) : [...pool];
    return shuffled.slice(0, want);
  });
  // ORDERING starts from a shuffled order — that order IS the initial response
  // (original indices), so "submit without touching" is graded honestly.
  const [responses, setResponses] = useState<Record<number, unknown>>(() => {
    const seed: Record<number, unknown> = {};
    for (const q of drawn) {
      if (q.question_type === 'ORDERING') {
        const n = ((parseData(q).items as OrderItem[]) ?? []).length;
        seed[q.id] = [...Array(n).keys()].sort(() => Math.random() - 0.5);
      }
    }
    return seed;
  });
  // MATCHING shows the right column shuffled; the permutation is fixed per
  // question for the whole attempt (a re-render must not reshuffle under you).
  const [rightOrder] = useState<Record<number, number[]>>(() => {
    const out: Record<number, number[]> = {};
    for (const q of drawn) {
      if (q.question_type === 'MATCHING') {
        const n = ((parseData(q).matches as MatchPair[]) ?? []).length;
        out[q.id] = [...Array(n).keys()].sort(() => Math.random() - 0.5);
      }
    }
    return out;
  });
  const [result, setResult] = useState<{ score: number; max: number; graded: Record<number, { correct: boolean; earned: number }> } | null>(null);
  const [startedAt] = useState(() => Date.now());
  // Countdown: a time-limited quiz/exam auto-submits at zero.
  const [secondsLeft, setSecondsLeft] = useState<number | null>(quiz.time_limit_minutes != null ? quiz.time_limit_minutes * 60 : null);
  const revealAnswers = quiz.show_answers_after !== 'NEVER';

  const submit = () => {
    const graded: Record<number, { correct: boolean; earned: number }> = {};
    let score = 0;
    let max = 0;
    for (const q of drawn) {
      const g = grade(q, responses[q.id]);
      graded[q.id] = g;
      score += g.earned;
      max += q.points;
    }
    setResult({ score, max, graded });
    void recordQuizAttempt({
      quizId: quiz.id,
      userId: Number(localStorage.getItem('currentUserId')) || undefined,
      score,
      maxScore: max,
      timeTakenSeconds: Math.round((Date.now() - startedAt) / 1000),
      answersJson: JSON.stringify(Object.fromEntries(drawn.map((q) => [q.id, { response: responses[q.id] ?? null, ...graded[q.id] }]))),
    }).catch((e) => {
      // A silent failure here cost a day of "why isn't my score saved" —
      // recording problems must SHOUT.
      notify({ kind: 'error', category: 'system', title: 'Attempt not saved', body: e instanceof Error ? e.message : String(e) });
    });
  };

  useEffect(() => {
    if (secondsLeft == null || result != null) return;
    if (secondsLeft <= 0) {
      submit();
      return;
    }
    const t = setTimeout(() => setSecondsLeft((x) => (x == null ? null : x - 1)), 1000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [secondsLeft, result]);

  const pct = result && result.max > 0 ? Math.round((result.score / result.max) * 100) : 0;

  // Exam review: per-topic breakdown (points earned / points possible per topic).
  const topicBreakdown = (() => {
    if (!result || !isExam) return null;
    const byTopic = new Map<number, { earned: number; max: number }>();
    for (const q of drawn) {
      const cur = byTopic.get(q.topic_id) ?? { earned: 0, max: 0 };
      cur.max += q.points;
      cur.earned += result.graded[q.id]?.earned ?? 0;
      byTopic.set(q.topic_id, cur);
    }
    return [...byTopic.entries()].map(([tid, v]) => ({
      name: topics.find((t) => t.id === tid)?.name ?? `topic #${tid}`,
      ...v,
    }));
  })();

  return createPortal(
    <div className="g-scrim z-[120] flex items-center justify-center p-6" onClick={onClose}>
      {/* DEFINITE height, not max-h: WKWebView won't shrink flex-1 children
          inside a max-height-only flex column, so the scroller never gets a
          bounded height and scrolling dies. h-[85vh] resolves the chain. */}
      <div className="g-card g-corners w-full max-w-2xl h-[85vh] overflow-hidden shadow-2xl flex flex-col min-h-0" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-6 py-4 border-b border-gilt-b shrink-0">
          <div>
            <div className="text-sm font-semibold text-text">
              {isExam && <span className="mr-1.5 text-[10px] font-bold uppercase px-1.5 py-0.5 rounded bg-warning/15 text-warning align-middle">exam</span>}
              {quiz.name}
            </div>
            <div className="text-[11px] text-subtext-0">{drawn.length} questions · pass ≥ {quiz.passing_score_percent}%{quiz.show_answers_after === 'NEVER' ? ' · answers hidden' : ''}</div>
          </div>
          {secondsLeft != null && result == null && (
            <span className={`text-sm font-mono px-2.5 py-1 rounded-lg ${secondsLeft <= 60 ? 'bg-error/15 text-error animate-pulse' : 'bg-surface-1 text-text'}`}>
              ⏱ {Math.floor(secondsLeft / 60)}:{String(secondsLeft % 60).padStart(2, '0')}
            </span>
          )}
          {result && (
            <span className={`text-sm font-bold px-3 py-1 rounded-lg ${pct >= quiz.passing_score_percent ? 'bg-success/15 text-success' : 'bg-error/15 text-error'}`}>
              {pct}% — {pct >= quiz.passing_score_percent ? 'passed' : 'failed'}
            </span>
          )}
          <button onClick={onClose} className="g-iconbtn ml-3" title="Close">✕</button>
        </div>
        <ScrollArea className="flex-1 min-h-0" contentClassName="p-5 space-y-5">
          {result && topicBreakdown && (
            <div className="rounded border border-surface-0 p-3.5 space-y-1.5">
              <div className="g-cap">By topic</div>
              {topicBreakdown.map((t) => (
                <div key={t.name} className="flex items-center gap-2">
                  <span className="text-[11px] text-subtext-1 w-48 truncate shrink-0">{t.name}</span>
                  <div className="flex-1 h-2 bg-surface-1 rounded-full overflow-hidden">
                    <div
                      className={`h-full ${t.max > 0 && t.earned / t.max >= 0.6 ? 'bg-success' : 'bg-error'}`}
                      style={{ width: `${t.max > 0 ? (t.earned / t.max) * 100 : 0}%` }}
                    />
                  </div>
                  <span className="text-[11px] text-subtext-0 w-12 text-right shrink-0">{t.earned}/{t.max}</span>
                </div>
              ))}
            </div>
          )}
          {drawn.length === 0 && <p className="text-sm text-subtext-0 italic">The bank has no runnable questions yet.</p>}
          {drawn.map((q, qi) => {
            const data = parseData(q);
            const g = result?.graded[q.id];
            return (
              <div key={q.id} className={`rounded border p-3.5 ${g == null ? 'border-surface-0' : g.correct ? 'border-success/50' : 'border-error/50'}`}>
                <div className="flex items-start gap-2">
                  <span className="text-[11px] text-subtext-0 shrink-0 mt-0.5">{qi + 1}.</span>
                  <div className="text-sm text-text flex-1">{q.question_text}</div>
                  <span className="text-[10px] text-subtext-0 shrink-0">{q.points} pt{q.points === 1 ? '' : 's'}</span>
                </div>
                <div className="mt-2.5 pl-5 space-y-1.5">
                  {q.question_type === 'IMAGE_IDENTIFICATION' && data.imagePath != null && String(data.imagePath) && (
                    <img src={String(data.imagePath)} alt={String(data.imageAltText ?? '')} className="max-h-64 rounded-lg border border-surface-0 object-contain mb-1" />
                  )}
                  {isChoice(q.question_type) &&
                    ((data.options as Option[]) ?? []).map((o, i) => {
                      const multi = q.question_type === 'MULTIPLE_CHOICE';
                      const picked = multi ? ((responses[q.id] as number[]) ?? []).includes(i) : responses[q.id] === i;
                      // Review truth-table: YOUR pick is judged (green/red);
                      // the correct answer is labeled when revealed.
                      const rowTint = !result
                        ? ''
                        : picked && o.isCorrect
                        ? 'bg-success/15'
                        : picked && !o.isCorrect
                        ? 'bg-error/15'
                        : revealAnswers && o.isCorrect
                        ? 'bg-success/5 border border-success/30'
                        : '';
                      return (
                        <label key={i} className={`flex items-center gap-2 text-sm rounded-lg px-2 py-1 cursor-pointer ${rowTint}`}>
                          <input
                            type={multi ? 'checkbox' : 'radio'}
                            checked={picked}
                            disabled={result != null}
                            onChange={(e) =>
                              setResponses((r) => {
                                if (!multi) return { ...r, [q.id]: i };
                                const cur = new Set((r[q.id] as number[]) ?? []);
                                if (e.target.checked) cur.add(i); else cur.delete(i);
                                return { ...r, [q.id]: [...cur] };
                              })
                            }
                            className="accent-[var(--color-primary)]"
                          />
                          <span className="text-text">{o.optionText}</span>
                          {result && picked && (
                            <span className={`text-xs ml-auto shrink-0 ${o.isCorrect ? 'text-success' : 'text-error'}`}>
                              {o.isCorrect ? '✓ your answer' : '✗ your answer'}
                            </span>
                          )}
                          {result && !picked && revealAnswers && o.isCorrect && (
                            <span className="text-success text-xs ml-auto shrink-0">✓ correct answer</span>
                          )}
                        </label>
                      );
                    })}
                  {q.question_type === 'FILL_BLANK' &&
                    ((data.blanks as Blank[]) ?? []).map((b, i) => (
                      <div key={i} className="flex items-center gap-2">
                        <input
                          value={((responses[q.id] as string[]) ?? [])[i] ?? ''}
                          disabled={result != null}
                          onChange={(e) =>
                            setResponses((r) => {
                              const cur = [...((r[q.id] as string[]) ?? [])];
                              cur[i] = e.target.value;
                              return { ...r, [q.id]: cur };
                            })
                          }
                          placeholder={`Blank ${i + 1}`}
                          className={`flex-1 min-h-[36px] px-2.5 py-1.5 text-sm bg-mantle rounded focus:outline-none focus:border-gold text-text border ${
                            result ? (g?.correct ? 'border-success/60' : 'border-error/60') : 'border-surface-1'
                          }`}
                        />
                        {result && revealAnswers && norm(((responses[q.id] as string[]) ?? [])[i]) !== norm(b.correctAnswer) && !alternates(b).some((a) => norm(a) === norm(((responses[q.id] as string[]) ?? [])[i])) && (
                          <span className="text-xs text-success">✓ {b.correctAnswer}{alternates(b).length ? ` (or ${alternates(b).join(', ')})` : ''}</span>
                        )}
                      </div>
                    ))}
                  {q.question_type === 'NUMERIC_INPUT' && (
                    <div className="flex items-center gap-2">
                      <input
                        value={(responses[q.id] as string) ?? ''}
                        disabled={result != null}
                        onChange={(e) => setResponses((r) => ({ ...r, [q.id]: e.target.value }))}
                        placeholder="Answer"
                        className={`w-40 min-h-[36px] px-2.5 py-1.5 text-sm bg-mantle rounded focus:outline-none focus:border-gold text-text border ${
                          result ? (g?.correct ? 'border-success/60' : 'border-error/60') : 'border-surface-1'
                        }`}
                      />
                      {data.unit != null && <span className="text-xs text-subtext-0">{String(data.unit)}</span>}
                      {result && <span className={`text-xs ${g?.correct ? 'text-success' : 'text-error'}`}>{g?.correct ? '✓' : '✗ your answer'}</span>}
                      {result && revealAnswers && !g?.correct && <span className="text-xs text-success">✓ = {String(data.correctAnswer)}</span>}
                    </div>
                  )}

                  {q.question_type === 'FILL_BLANK_MULTIPLE' &&
                    ((data.blanks as DropdownBlank[]) ?? []).map((b, i) => {
                      const got = ((responses[q.id] as string[]) ?? [])[i] ?? '';
                      const right = result != null && norm(got) === norm(b.correctAnswer);
                      return (
                        <div key={i} className="flex items-center gap-2">
                          <span className="text-[11px] text-subtext-0 w-14 shrink-0">Blank {i + 1}</span>
                          <select
                            value={got}
                            disabled={result != null}
                            onChange={(e) => setResponses((r) => { const cur = [...((r[q.id] as string[]) ?? [])]; cur[i] = e.target.value; return { ...r, [q.id]: cur }; })}
                            className={`flex-1 min-h-[36px] px-2.5 py-1.5 text-sm bg-mantle rounded focus:outline-none focus:border-gold text-text border ${result ? (right ? 'border-success/60' : 'border-error/60') : 'border-surface-1'}`}
                          >
                            <option value="">— choose —</option>
                            {(b.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
                          </select>
                          {result && revealAnswers && !right && <span className="text-xs text-success shrink-0">✓ {b.correctAnswer}</span>}
                        </div>
                      );
                    })}

                  {q.question_type === 'MATCHING' && (() => {
                    const pairs = (data.matches as MatchPair[]) ?? [];
                    const perm = rightOrder[q.id] ?? pairs.map((_, i) => i);
                    const picks = (responses[q.id] as Record<number, number>) ?? {};
                    return pairs.map((p, i) => {
                      const right = result != null && picks[i] === i;
                      return (
                        <div key={i} className="flex items-center gap-2">
                          <span className="text-sm text-text flex-1 min-w-0 truncate">{p.leftItem}</span>
                          <span className="text-subtext-0 text-xs shrink-0">↔</span>
                          <select
                            value={picks[i] ?? ''}
                            disabled={result != null}
                            onChange={(e) => setResponses((r) => ({ ...r, [q.id]: { ...((r[q.id] as Record<number, number>) ?? {}), [i]: Number(e.target.value) } }))}
                            className={`flex-1 min-w-0 min-h-[36px] px-2.5 py-1.5 text-sm bg-mantle rounded focus:outline-none focus:border-gold text-text border ${result ? (right ? 'border-success/60' : 'border-error/60') : 'border-surface-1'}`}
                          >
                            <option value="">— choose —</option>
                            {perm.map((orig) => <option key={orig} value={orig}>{pairs[orig]?.rightItem}</option>)}
                          </select>
                          {result && revealAnswers && !right && <span className="text-xs text-success shrink-0 truncate max-w-[10rem]">✓ {p.rightItem}</span>}
                        </div>
                      );
                    });
                  })()}

                  {q.question_type === 'ORDERING' && (() => {
                    const items = (data.items as OrderItem[]) ?? [];
                    const order = (responses[q.id] as number[]) ?? items.map((_, i) => i);
                    const move = (pos: number, dir: -1 | 1) =>
                      setResponses((r) => {
                        const cur = [...((r[q.id] as number[]) ?? order)];
                        const to = pos + dir;
                        if (to < 0 || to >= cur.length) return r;
                        [cur[pos], cur[to]] = [cur[to], cur[pos]];
                        return { ...r, [q.id]: cur };
                      });
                    return (
                      <div className="space-y-1">
                        {order.map((orig, pos) => {
                          const right = result != null && items[orig]?.correctPosition === pos + 1;
                          return (
                            <div key={orig} className={`flex items-center gap-2 rounded-lg px-2 py-1 border ${result ? (right ? 'border-success/50 bg-success/5' : 'border-error/50 bg-error/5') : 'border-surface-1 bg-mantle'}`}>
                              <span className="text-[11px] text-subtext-0 w-4 shrink-0">{pos + 1}.</span>
                              <span className="text-sm text-text flex-1 min-w-0">{items[orig]?.itemText}</span>
                              {result == null && (
                                <>
                                  <button onClick={() => move(pos, -1)} disabled={pos === 0} className="text-subtext-0 hover:text-text text-xs px-1 disabled:opacity-30">↑</button>
                                  <button onClick={() => move(pos, 1)} disabled={pos === order.length - 1} className="text-subtext-0 hover:text-text text-xs px-1 disabled:opacity-30">↓</button>
                                </>
                              )}
                              {result && revealAnswers && !right && <span className="text-xs text-success shrink-0">→ {items[orig]?.correctPosition}</span>}
                            </div>
                          );
                        })}
                      </div>
                    );
                  })()}

                  {q.question_type === 'CALCULATION' && (() => {
                    const vars = (data.variables as CalcVariable[]) ?? [];
                    const answers = (data.answers as CalcAnswer[]) ?? [];
                    const given = (responses[q.id] as string[]) ?? [];
                    return (
                      <div className="space-y-2">
                        {vars.length > 0 && (
                          <div className="flex flex-wrap gap-1.5">
                            {vars.map((v, i) => (
                              <span key={i} className="text-xs px-2 py-0.5 rounded-md bg-surface-0 text-subtext-1 font-mono">
                                {v.name} = {v.value}{v.unit ? ` ${v.unit}` : ''}
                              </span>
                            ))}
                          </div>
                        )}
                        {answers.map((a, i) => {
                          const right = result != null && !isNaN(parseFloat(given[i] ?? '')) && Math.abs(parseFloat(given[i]) - a.correctValue) <= (a.tolerance ?? 0);
                          return (
                            <div key={i} className="flex items-center gap-2">
                              <span className="text-sm text-subtext-1 w-40 shrink-0 truncate">{a.label}</span>
                              <input
                                value={given[i] ?? ''}
                                disabled={result != null}
                                onChange={(e) => setResponses((r) => { const cur = [...((r[q.id] as string[]) ?? [])]; cur[i] = e.target.value; return { ...r, [q.id]: cur }; })}
                                placeholder="value"
                                className={`w-32 min-h-[36px] px-2.5 py-1.5 text-sm bg-mantle rounded focus:outline-none focus:border-gold text-text border ${result ? (right ? 'border-success/60' : 'border-error/60') : 'border-surface-1'}`}
                              />
                              {a.unit && <span className="text-xs text-subtext-0">{a.unit}</span>}
                              {result && revealAnswers && !right && <span className="text-xs text-success">✓ = {a.correctValue}{a.tolerance ? ` (± ${a.tolerance})` : ''}</span>}
                            </div>
                          );
                        })}
                        {result && revealAnswers && Array.isArray(data.solutionSteps) && (data.solutionSteps as string[]).length > 0 && (
                          <ol className="list-decimal pl-5 text-xs text-subtext-1 space-y-0.5">
                            {(data.solutionSteps as string[]).map((st, i) => <li key={i}>{st}</li>)}
                          </ol>
                        )}
                      </div>
                    );
                  })()}
                  {result && revealAnswers && q.explanation && (
                    <p className="text-xs text-subtext-1 bg-mantle border border-surface-0 rounded-lg px-2.5 py-1.5 mt-1">{q.explanation}</p>
                  )}
                </div>
              </div>
            );
          })}
        </ScrollArea>
        <div className="px-6 py-3 border-t border-gilt-b shrink-0 flex justify-end gap-2">
          {result == null ? (
            <button onClick={submit} disabled={drawn.length === 0} className="g-btn g-btn-pri">
              Submit answers
            </button>
          ) : (
            <button onClick={onClose} className="g-btn g-btn-ghost">
              Done
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
