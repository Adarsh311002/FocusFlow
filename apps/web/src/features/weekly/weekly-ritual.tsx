import {
  addCalendarDays,
  TASK_TITLE_MAX_LENGTH,
  type TaskId,
  WEEKLY_PRIORITIES_MAX,
} from '@focus-flow/contracts';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useId, useRef, useState } from 'react';

import { buttonClass, INPUT_CLASS } from '../../ui/primitives';
import { RitualShell } from '../../ui/ritual-shell';
import { useAuth } from '../auth/auth-context';
import { usePromptState } from '../intention/intention-ritual';
import { formatDuration } from '../review/review-format';
import { useFocusSessionInsights } from '../review/review-queries';
import { useTaskList } from '../tasks/task-queries';
import { createTask } from '../tasks/tasks-client';
import {
  currentWeek,
  OPEN_WEEKLY_REVIEW,
  rememberWeeklyReview,
  useSetWeeklyPriorities,
  useWeeklyPriorities,
  weeklyReviewAnswered,
} from './weekly-queries';

// The weekly review (WR4): on the first signed-in page of each local week, a full-screen
// look back at last week, then "what are this week's three?". It comes before the daily
// intention (which waits for it), skips a brand-new user with no history, and can be opened
// on demand from the dashboard. Answered or skipped is remembered per user and week in this
// browser only.

const APPEAR_AFTER_MS = 700;
const CONFIRM_FOR_MS = 1800;
const EASE = [0.22, 1, 0.36, 1] as const;

export function WeeklyReviewRitual() {
  const { enabled, setWeeklyBlocking } = usePromptState();
  const { status, user } = useAuth();
  const [{ week, tz }] = useState(() => currentWeek());
  const lastWeek = { from: addCalendarDays(week, -7), to: addCalendarDays(week, -1), tz };
  const [handled, setHandled] = useState<readonly string[]>([]);
  const [opened, setOpened] = useState(false);
  const [ready, setReady] = useState(false);
  const signedIn = enabled && status === 'authenticated' && user !== null;
  const unanswered = signedIn && !handled.includes(user.id) && !weeklyReviewAnswered(user.id, week);
  const history = useFocusSessionInsights(lastWeek);

  useEffect(() => {
    const timer = setTimeout(() => {
      setReady(true);
    }, APPEAR_AFTER_MS);
    const open = (): void => {
      setOpened(true);
    };
    window.addEventListener(OPEN_WEEKLY_REVIEW, open);
    return () => {
      clearTimeout(timer);
      window.removeEventListener(OPEN_WEEKLY_REVIEW, open);
    };
  }, []);

  // A brand-new user has no week to look back on: no review, straight to the daily one.
  const isNew =
    history.isSuccess &&
    history.data.totals.sessionCount === 0 &&
    history.data.streak.longest === 0;
  useEffect(() => {
    if (unanswered && isNew) {
      // Only a note for next time; `isNew` already keeps the review closed now.
      rememberWeeklyReview(user.id, week, 'new');
    }
  }, [unanswered, isNew, user, week]);

  // Hold the daily intention while this review is still due (or still deciding).
  const blocking = unanswered && !isNew;
  useEffect(() => {
    setWeeklyBlocking(blocking);
  }, [blocking, setWeeklyBlocking]);

  const due = signedIn && (opened || (blocking && ready && history.isSuccess));

  return (
    <AnimatePresence>
      {due && (
        <WeeklyDialog
          key={`${user.id}:${week}`}
          week={week}
          lastWeekFrom={lastWeek.from}
          onDone={(outcome) => {
            rememberWeeklyReview(user.id, week, outcome);
            setHandled((current) => [...current, user.id]);
            setOpened(false);
          }}
        />
      )}
    </AnimatePresence>
  );
}

function WeeklyDialog({
  week,
  lastWeekFrom,
  onDone,
}: {
  readonly week: string;
  readonly lastWeekFrom: string;
  readonly onDone: (outcome: 'set' | 'skipped') => void;
}) {
  const [{ tz }] = useState(() => currentWeek());
  const history = useFocusSessionInsights({
    from: lastWeekFrom,
    to: addCalendarDays(week, -1),
    tz,
  });
  const previous = useWeeklyPriorities(lastWeekFrom);
  const current = useWeeklyPriorities(week);
  const openTasks = useTaskList('open');
  const save = useSetWeeklyPriorities();
  const [chosen, setChosen] = useState<readonly TaskId[] | null>(null);
  const [newTitle, setNewTitle] = useState('');
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const first = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const newId = useId();

  const picked = chosen ?? current.data?.priorities.map((entry) => entry.task.id) ?? [];
  const tasks = openTasks.data?.pages.flatMap((page) => page.tasks) ?? [];
  const full = picked.length >= WEEKLY_PRIORITIES_MAX;
  const stats = history.data;
  const checkIns = stats?.checkIns;

  function toggle(id: TaskId): void {
    setChosen(
      picked.includes(id)
        ? picked.filter((existing) => existing !== id)
        : full
          ? picked
          : [...picked, id],
    );
  }

  async function addNew(): Promise<void> {
    const title = newTitle.trim();
    if (title === '' || full || adding) {
      return;
    }
    setAdding(true);
    setError(null);
    try {
      const task = await createTask(title);
      setChosen([...picked, task.id]);
      setNewTitle('');
      await openTasks.refetch();
    } catch {
      setError('That did not save. Check your connection and try again.');
    } finally {
      setAdding(false);
    }
  }

  async function commit(): Promise<void> {
    setError(null);
    try {
      await save.mutateAsync({ week, taskIds: picked });
      setConfirmation(
        picked.length === 0
          ? 'A open week. Go gently.'
          : `${String(picked.length)} ${picked.length === 1 ? 'priority' : 'priorities'} for this week.`,
      );
      setTimeout(() => {
        onDone('set');
      }, CONFIRM_FOR_MS);
    } catch {
      setError('That did not save. Check your connection and try again.');
    }
  }

  const busy = save.isPending || adding;

  return (
    <RitualShell
      titleId={titleId}
      initialFocus={first}
      onEscape={
        busy || confirmation !== null
          ? null
          : () => {
              onDone('skipped');
            }
      }
    >
      <AnimatePresence mode="wait">
        {confirmation === null ? (
          <motion.div
            key="review"
            className="relative w-full max-w-3xl space-y-10"
            initial={{ opacity: 0, y: 24 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -16 }}
            transition={{ duration: 0.9, delay: 0.15, ease: EASE }}
          >
            <div className="space-y-4 text-center">
              <p className="text-xs tracking-[0.35em] text-focus uppercase">( A new week )</p>
              <h2 id={titleId} className="font-display text-5xl leading-[1.05] md:text-6xl">
                Look back, then
                <br />
                <em className="text-focus">choose three.</em>
              </h2>
            </div>

            <section aria-label="Last week" className="space-y-4">
              <dl className="grid grid-cols-2 gap-4 text-center md:grid-cols-4">
                <Stat
                  label="Focused"
                  value={
                    stats === undefined ? '…' : formatDuration(stats.totals.totalFocusedSeconds)
                  }
                />
                <Stat
                  label="Sessions"
                  value={stats === undefined ? '…' : String(stats.totals.sessionCount)}
                />
                <Stat
                  label="Intentions done"
                  value={
                    checkIns === undefined || checkIns.withIntention === 0
                      ? '—'
                      : `${String(checkIns.done)}/${String(checkIns.withIntention)}`
                  }
                />
                <Stat
                  label="Got stuck"
                  value={checkIns === undefined ? '…' : String(checkIns.stuck)}
                />
              </dl>
              {(previous.data?.priorities.length ?? 0) > 0 && (
                <div className="space-y-1 text-sm">
                  <p className="text-muted">Last week’s three:</p>
                  <ul aria-label="Last week’s priorities" className="flex flex-wrap gap-2">
                    {previous.data?.priorities.map((entry) => (
                      <li
                        key={entry.task.id}
                        className={`rounded-full border px-3 py-1 ${
                          entry.task.status === 'completed'
                            ? 'border-focus/50 text-focus'
                            : 'border-line text-muted'
                        }`}
                      >
                        {entry.task.status === 'completed' ? '✓ ' : ''}
                        {entry.task.title}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </section>

            <section aria-labelledby={`${titleId}-pick`} className="space-y-4">
              <h3 id={`${titleId}-pick`} className="font-display text-3xl">
                {`This week’s three (${String(picked.length)}/${String(WEEKLY_PRIORITIES_MAX)})`}
              </h3>
              <div
                role="group"
                aria-label="Open tasks"
                className="flex max-h-56 flex-wrap gap-2 overflow-y-auto"
              >
                {tasks.length === 0 && (
                  <p className="text-sm text-muted">No open tasks yet. Name one below.</p>
                )}
                {tasks.map((task, index) => {
                  const on = picked.includes(task.id);
                  return (
                    <button
                      key={task.id}
                      ref={index === 0 ? first : undefined}
                      type="button"
                      aria-pressed={on}
                      disabled={busy || (!on && full)}
                      onClick={() => {
                        toggle(task.id);
                      }}
                      className={`rounded-full border px-4 py-2 text-sm transition ${
                        on
                          ? 'border-focus bg-focus/15 shadow-glow'
                          : 'border-line bg-surface hover:bg-surface-strong disabled:opacity-40'
                      }`}
                    >
                      {on ? `${String(picked.indexOf(task.id) + 1)}. ` : ''}
                      {task.title}
                    </button>
                  );
                })}
              </div>
              <form
                className="flex gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  void addNew();
                }}
              >
                <label htmlFor={newId} className="sr-only">
                  A new priority
                </label>
                <input
                  id={newId}
                  type="text"
                  value={newTitle}
                  maxLength={TASK_TITLE_MAX_LENGTH}
                  disabled={busy || full}
                  placeholder={full ? 'Three chosen' : 'Or name a new one…'}
                  onChange={(event) => {
                    setNewTitle(event.target.value);
                  }}
                  className={INPUT_CLASS}
                />
                <button
                  type="submit"
                  disabled={busy || full || newTitle.trim() === ''}
                  className={buttonClass('ghost', 'px-4')}
                >
                  Add
                </button>
              </form>
            </section>

            <div className="flex flex-col items-center gap-4">
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  void commit();
                }}
                className={buttonClass('primary', 'px-10 py-3.5 text-base')}
              >
                {save.isPending ? 'Saving…' : 'Begin the week'}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  onDone('skipped');
                }}
                className="text-sm text-muted underline-offset-4 transition hover:text-ink hover:underline"
              >
                Not this week
              </button>
              {error !== null && (
                <p role="alert" className="text-sm text-danger">
                  {error}
                </p>
              )}
            </div>
          </motion.div>
        ) : (
          <motion.div
            key="done"
            role="status"
            className="relative space-y-4 text-center"
            initial={{ opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.7, ease: EASE }}
          >
            <p aria-hidden="true" className="text-4xl">
              🌿
            </p>
            <p className="font-display text-4xl md:text-5xl">{confirmation}</p>
          </motion.div>
        )}
      </AnimatePresence>
    </RitualShell>
  );
}

function Stat({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="rounded-2xl border border-line bg-surface/60 p-4">
      <dt className="text-[10px] tracking-[0.3em] text-muted uppercase">{label}</dt>
      <dd className="font-display mt-1 text-3xl">{value}</dd>
    </div>
  );
}
