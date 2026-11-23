import { motion } from 'motion/react';
import type { ReactNode } from 'react';

import { ForestVisual } from '../../ui/forest-visual';
import { ButterflyArt, Critter, FrogArt, MonkeyArt } from '../../ui/jungle/critters';
import { useAuth } from '../auth/auth-context';
import { FocusPanel } from '../focus/focus-panel';
import { useCachedCurrentFocusSession } from '../focus/focus-queries';
import { ConnectionStatus } from '../realtime/connection-status';
import { CurrentTask } from '../tasks/current-task';
import { TasksPanel } from '../tasks/tasks-panel';
import { TodayStrip } from './today-strip';
import { WeekOverview } from './week-overview';

const EASE = [0.22, 1, 0.36, 1] as const;

function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 5) {
    return 'Still up';
  }
  if (hour < 12) {
    return 'Good morning';
  }
  if (hour < 18) {
    return 'Good afternoon';
  }
  return 'Good evening';
}

function todayLabel(): string {
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(new Date());
}

/** Fades a dashboard block in, one after another. */
function Block({
  children,
  index,
  className,
}: {
  readonly children: ReactNode;
  readonly index: number;
  readonly className?: string;
}) {
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y: 24 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.9, delay: 0.1 + index * 0.08, ease: EASE }}
    >
      {children}
    </motion.div>
  );
}

/**
 * The clearing: the ancient tree fills the scene and the timer stands in front of it. The
 * fireflies gather while a session runs. The current task hangs in the scene like a sign.
 */
function Clearing() {
  const session = useCachedCurrentFocusSession();
  const running = session?.status === 'in_progress' && session.runningSince !== null;
  const paused = session?.status === 'in_progress' && session.runningSince === null;
  const mood = running
    ? 'Deep focus · the forest is awake'
    : paused
      ? 'Paused · the forest holds its breath'
      : 'Still · the clearing is yours';

  return (
    <div className="relative overflow-hidden rounded-[2.5rem] border border-line bg-canvas-2 shadow-card">
      <ForestVisual
        energy={running ? 0.95 : paused ? 0.3 : 0.12}
        className="absolute inset-0 h-full w-full lg:left-[28%]"
      />
      {/* Darkness on the left, so the timer reads clearly over the forest. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-gradient-to-r from-canvas-2 via-canvas-2/85 to-transparent lg:via-canvas-2/70"
      />
      <div className="relative grid gap-8 p-6 md:p-10 lg:min-h-[560px] lg:grid-cols-[minmax(0,480px)_1fr]">
        <div className="flex flex-col justify-center">
          <FocusPanel variant="bare" />
        </div>
        <div className="flex flex-col justify-between gap-6">
          <p
            aria-hidden="true"
            className="self-end rounded-full border border-line bg-canvas/60 px-4 py-2 text-xs text-muted backdrop-blur-md"
          >
            <span
              className={`mr-2 inline-block h-1.5 w-1.5 rounded-full align-middle ${running ? 'animate-pulse bg-focus' : 'bg-muted/50'}`}
            />
            {mood}
          </p>
          <div className="lg:ml-auto lg:max-w-sm">
            <CurrentTask variant="sign" />
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * The signed-in home: the clearing where you decide and focus, the day at a glance, then
 * the task list beside the week.
 */
export function DashboardPage() {
  const { user } = useAuth();
  const firstName = user?.displayName.split(' ')[0] ?? '';

  return (
    <section aria-labelledby="dashboard-heading" className="relative space-y-10">
      <Critter kind="monkey" className="-top-24 right-[30%] hidden xl:block" bubble="left">
        <MonkeyArt vine={70} />
      </Critter>
      <Critter kind="butterfly" className="top-4 right-[8%] hidden lg:block" bubble="left">
        <ButterflyArt />
      </Critter>
      <Critter kind="frog" className="-bottom-20 left-[44%] hidden lg:block" bubble="right">
        <FrogArt />
      </Critter>

      <Block index={0}>
        <p className="text-xs tracking-[0.3em] text-focus uppercase">{todayLabel()}</p>
        <h2 id="dashboard-heading" className="sr-only">
          Dashboard
        </h2>
        <p aria-hidden="true" className="font-display mt-3 text-5xl leading-none md:text-7xl">
          {greeting()}
          {firstName !== '' && (
            <>
              , <em className="text-focus">{firstName}</em>
            </>
          )}
          .
        </p>
        {user === null && <p className="mt-4 text-muted">No signed-in user.</p>}
        {user !== null && (
          <div className="sr-only">
            <ConnectionStatus />
          </div>
        )}
      </Block>

      {user !== null && (
        <>
          <Block index={1}>
            <Clearing />
          </Block>
          <Block index={2}>
            <TodayStrip />
          </Block>
          <div className="grid items-start gap-10 lg:grid-cols-12">
            <Block index={3} className="lg:col-span-7">
              <TasksPanel />
            </Block>
            <Block index={4} className="lg:col-span-5">
              <WeekOverview showStats={false} />
            </Block>
          </div>
        </>
      )}
    </section>
  );
}
