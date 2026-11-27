import { TASK_TITLE_MAX_LENGTH } from '@focus-flow/contracts';
import { AnimatePresence, motion } from 'motion/react';
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';

import { buttonClass } from '../../ui/primitives';
import { RitualShell } from '../../ui/ritual-shell';
import { useAuth } from '../auth/auth-context';
import { useTask } from '../tasks/task-queries';
import {
  dailyGoalOf,
  dailyIntentionAnswered,
  rememberDailyIntention,
  useAdoptIntention,
  useSetDailyGoal,
} from './intention-queries';

/* The daily intention ritual (IN3): the first signed-in page of each local day opens with a
   full-screen pause that asks what would make today a good day and how much deep focus the
   user is aiming for. It is skippable ("Not today" or Esc) but hard to miss.

   It appears only inside an <IntentionPromptProvider>, which the real app mounts in
   AppProviders. Page tests build their own providers and so never meet it unless they ask
   for it, which keeps them about the page they test. */

type PromptState = {
  readonly enabled: boolean;
  /** The weekly review (WR4) is due or deciding: the daily intention waits for it. */
  readonly weeklyBlocking: boolean;
  readonly setWeeklyBlocking: (blocking: boolean) => void;
};

const PromptContext = createContext<PromptState>({
  enabled: false,
  weeklyBlocking: false,
  setWeeklyBlocking: () => undefined,
});

/** Turns the rituals (daily intention, weekly review) on for everything inside it. */
export function IntentionPromptProvider({ children }: { readonly children: ReactNode }) {
  const [weeklyBlocking, setWeeklyBlocking] = useState(false);
  const value = useMemo(
    () => ({ enabled: true, weeklyBlocking, setWeeklyBlocking }),
    [weeklyBlocking],
  );
  return <PromptContext value={value}>{children}</PromptContext>;
}

/** Whether the rituals are on here, and the weekly review's hold on the daily one. */
export function usePromptState(): PromptState {
  return useContext(PromptContext);
}

const GOAL_HOURS = [1, 2, 3, 4, 6] as const;
const EASE = [0.22, 1, 0.36, 1] as const;
/** A short breath before the ritual appears, so the page settles first. */
const APPEAR_AFTER_MS = 700;
const CONFIRM_FOR_MS = 1800;

function hoursLabel(hours: number): string {
  return hours === 1 ? '1 hour' : `${String(hours)} hours`;
}

/** Shows the ritual once per user and local day, after sign-in, on any signed-in page. */
export function DailyIntentionRitual() {
  const { enabled, weeklyBlocking } = useContext(PromptContext);
  const { status, user } = useAuth();
  // Users this mounted shell has already asked (answered or skipped) during this visit.
  const [handled, setHandled] = useState<readonly string[]>([]);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => {
      setReady(true);
    }, APPEAR_AFTER_MS);
    return () => {
      clearTimeout(timer);
    };
  }, []);

  const due =
    enabled &&
    !weeklyBlocking &&
    ready &&
    status === 'authenticated' &&
    user !== null &&
    !handled.includes(user.id) &&
    !dailyIntentionAnswered(user.id);

  return (
    <AnimatePresence>
      {due && (
        <RitualDialog
          key={user.id}
          onDone={() => {
            setHandled((current) => [...current, user.id]);
          }}
        />
      )}
    </AnimatePresence>
  );
}

function RitualDialog({ onDone }: { readonly onDone: () => void }) {
  const { user } = useAuth();
  const userId = user?.id ?? '';
  const currentGoal = dailyGoalOf(user);
  const currentTask = useTask(user?.currentTaskId ?? null);
  const adopt = useAdoptIntention();
  const setGoal = useSetDailyGoal();
  const [text, setText] = useState('');
  const [goalHours, setGoalHours] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const hintId = useId();

  const pending = adopt.isPending || setGoal.isPending;
  const chosenHours = goalHours ?? currentGoal / 3600;
  const keepTitle = currentTask.data?.status === 'open' ? currentTask.data.title : null;

  function skip(): void {
    rememberDailyIntention(userId, 'skipped');
    onDone();
  }

  async function commit(): Promise<void> {
    setError(null);
    const title = text.trim();
    try {
      let thing = keepTitle;
      if (title !== '') {
        thing = (await adopt.mutateAsync(title)).title;
      }
      if (goalHours !== null && goalHours * 3600 !== currentGoal) {
        await setGoal.mutateAsync(goalHours * 3600);
      }
      rememberDailyIntention(userId, 'set');
      setConfirmation(
        thing === null
          ? `${hoursLabel(chosenHours)} of deep focus today.`
          : `${thing} · ${hoursLabel(chosenHours)} of deep focus.`,
      );
      setTimeout(onDone, CONFIRM_FOR_MS);
    } catch {
      setError('That did not save. Check your connection and try again.');
    }
  }

  return (
    <RitualShell
      titleId={titleId}
      describedById={hintId}
      initialFocus={input}
      onEscape={pending || confirmation !== null ? null : skip}
    >
      <AnimatePresence mode="wait">
        {confirmation === null ? (
          <motion.form
            key="ask"
            noValidate
            className="relative w-full max-w-2xl space-y-10 text-center"
            initial={{ opacity: 0, y: 24 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -16 }}
            transition={{ duration: 0.9, delay: 0.15, ease: EASE }}
            onSubmit={(event) => {
              event.preventDefault();
              void commit();
            }}
          >
            <div className="space-y-4">
              <p className="text-xs tracking-[0.35em] text-focus uppercase">( Before you begin )</p>
              <h2 id={titleId} className="font-display text-5xl leading-[1.05] md:text-7xl">
                What would make today
                <br />
                <em className="text-focus">a good day?</em>
              </h2>
            </div>

            <div className="space-y-3">
              <label htmlFor="ritual-intention" className="sr-only">
                Today’s one thing
              </label>
              <input
                ref={input}
                id="ritual-intention"
                type="text"
                autoComplete="off"
                maxLength={TASK_TITLE_MAX_LENGTH}
                value={text}
                placeholder={
                  keepTitle === null ? 'Name one thing…' : `Keep going with “${keepTitle}”…`
                }
                onChange={(event) => {
                  setText(event.target.value);
                }}
                className="w-full !rounded-none !border-0 !border-b-2 !border-focus/40 !bg-transparent px-2 py-4 text-center font-display !text-3xl focus:!border-focus focus:!shadow-none md:!text-4xl"
              />
              <p id={hintId} className="text-sm text-muted">
                It becomes your current task, so every session today starts from it.
              </p>
            </div>

            <fieldset className="space-y-4">
              <legend className="mx-auto mb-4 text-sm text-muted">
                How much deep focus today?
              </legend>
              <div className="flex flex-wrap justify-center gap-2">
                {GOAL_HOURS.map((hours) => (
                  <label
                    key={hours}
                    className="cursor-pointer rounded-full border border-line bg-surface px-5 py-2.5 text-sm transition hover:bg-surface-strong has-[:checked]:border-focus has-[:checked]:bg-focus/15 has-[:checked]:shadow-glow has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-focus"
                  >
                    <input
                      type="radio"
                      name="ritual-goal"
                      className="sr-only"
                      checked={chosenHours === hours}
                      onChange={() => {
                        setGoalHours(hours);
                      }}
                    />
                    {hoursLabel(hours)}
                  </label>
                ))}
              </div>
            </fieldset>

            <div className="flex flex-col items-center gap-4">
              <button
                type="submit"
                disabled={pending}
                className={buttonClass('primary', 'px-10 py-3.5 text-base')}
              >
                {pending ? 'Saving…' : 'Begin my day'}
              </button>
              <button
                type="button"
                disabled={pending}
                onClick={skip}
                className="text-sm text-muted underline-offset-4 transition hover:text-ink hover:underline"
              >
                Not today
              </button>
              {error !== null && (
                <p role="alert" className="text-sm text-danger">
                  {error}
                </p>
              )}
            </div>
          </motion.form>
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
            <p className="text-sm text-muted">The forest is listening. Go gently.</p>
          </motion.div>
        )}
      </AnimatePresence>
    </RitualShell>
  );
}
