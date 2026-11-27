import {
  DEEP_FOCUS_PAUSE_SECONDS,
  DEEP_FOCUS_PAUSES_ALLOWED,
  type FocusSessionView,
} from '@focus-flow/contracts';
import { useEffect, useRef, useState } from 'react';

import { ProgressRing } from '../../ui/progress-ring';
import { useAuth } from '../auth/auth-context';
import { focusErrorMessage } from '../focus/focus-messages';
import {
  useBreakFocusSession,
  useCachedCurrentFocusSession,
  useCurrentFocusSession,
  usePauseFocusSession,
  useRecordFocusDistraction,
  useResumeFocusSession,
  useStopFocusSession,
} from '../focus/focus-queries';
import { focusedSecondsAt, formatClock, remainingSecondsAt } from '../focus/focus-time';
import { useServerNowMs } from '../focus/use-server-now';
import { ParkThought } from '../thoughts/thoughts';
import {
  claimDeepFocus,
  enterFullscreen,
  exitFullscreen,
  fullscreenSupported,
  keepScreenAwake,
  ownsDeepFocus,
  userIsPresent,
} from './browser';
import {
  initialLeaveGuard,
  type LeaveGuardEffect,
  type LeaveGuardState,
  secondsLeft,
  stepLeaveGuard,
} from './leave-guard';
import { SoundPicker, usePlayingSounds } from './sound-picker';
import { stopAllSounds } from './sounds';

// Deep Focus (DF1–DF5): a full-screen session the page watches. It covers every route while
// a Deep Focus session is in progress, holds the app's pop-ups back, and allows one pause.
// The browser decides only the "you left" rule the user chose when starting (DF2); every
// other outcome is still the server's (W3).

type InProgress = Extract<FocusSessionView, { status: 'in_progress' }>;

/** How long after the guard (re)starts an absence is forgiven: full screen is asynchronous. */
const SETTLE_MS = 1_500;
const SAMPLE_EVERY_MS = 250;
const HOLD_TO_END_MS = 3_000;

const LIGHT_BUTTON =
  'rounded-full border border-white/20 bg-white/5 px-5 py-2.5 text-sm text-white/90 transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40';
const BRIGHT_BUTTON =
  'rounded-full bg-white px-6 py-2.5 text-sm font-medium text-black transition hover:bg-white/90 disabled:opacity-50';

function deepSessionOf(session: FocusSessionView | null | undefined): InProgress | null {
  return session?.status === 'in_progress' &&
    session.context.kind === 'solo' &&
    session.deepFocus !== undefined
    ? session
    : null;
}

/** Whether a Deep Focus session is in progress, as far as the cache knows (pop-ups hold back). */
export function useDeepFocusActive(): boolean {
  return deepSessionOf(useCachedCurrentFocusSession()) !== null;
}

/** Mounted once in the signed-in layout. */
export function DeepFocusLayer() {
  const { status } = useAuth();
  if (status !== 'authenticated') {
    return null;
  }
  return <DeepFocusWatcher />;
}

function DeepFocusWatcher() {
  const session = deepSessionOf(useCurrentFocusSession().data);
  if (session === null) {
    return null;
  }
  return <DeepFocusOwner key={session.id} session={session} />;
}

function DeepFocusOwner({ session }: { readonly session: InProgress }) {
  const [owner, setOwner] = useState(() => ownsDeepFocus(session.id));
  if (!owner) {
    return (
      <Screen>
        <p className="text-sm tracking-[0.3em] text-white/50 uppercase">Deep Focus</p>
        <p className="font-display text-3xl text-white">
          {session.task?.title ?? 'A Deep Focus session is running'}
        </p>
        <p className="max-w-sm text-sm text-white/60">
          It is watched in the tab where it started. Continue here if that tab is closed.
        </p>
        <button
          type="button"
          className={BRIGHT_BUTTON}
          onClick={() => {
            claimDeepFocus(session.id);
            enterFullscreen();
            setOwner(true);
          }}
        >
          Continue here
        </button>
      </Screen>
    );
  }
  return <DeepFocusScreen session={session} />;
}

function Screen({ children }: { readonly children: React.ReactNode }) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Deep Focus"
      className="fixed inset-0 z-[100] flex flex-col items-center justify-center gap-6 overflow-y-auto bg-[#05070a] px-4 py-10 text-center text-white"
    >
      {children}
    </div>
  );
}

/** The local pause start, remembered per session so a reload keeps the pause clock. */
function pauseStartOf(sessionId: string, paused: boolean): number | null {
  const key = `ff-deep-pause:${sessionId}`;
  try {
    if (!paused) {
      window.sessionStorage.removeItem(key);
      return null;
    }
    const stored = Number(window.sessionStorage.getItem(key));
    if (Number.isFinite(stored) && stored > 0) {
      return stored;
    }
    const now = Date.now();
    window.sessionStorage.setItem(key, String(now));
    return now;
  } catch {
    return paused ? Date.now() : null;
  }
}

/** The page's own clock, ticking once a second while paused (the guard is off then). */
function usePauseClock(paused: boolean): number {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!paused) {
      return undefined;
    }
    const timer = setInterval(() => {
      setNowMs(Date.now());
    }, 1_000);
    return () => {
      clearInterval(timer);
    };
  }, [paused]);
  return nowMs;
}

/**
 * The guard: samples "is the user here?" on every relevant browser event and a few times a
 * second, and performs what `stepLeaveGuard` decides.
 */
function useLeaveGuard(
  active: boolean,
  onEffect: (effect: Exclude<LeaveGuardEffect, 'none'>) => void,
): { state: LeaveGuardState; nowMs: number } {
  const [state, setState] = useState<LeaveGuardState>(initialLeaveGuard);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const stateRef = useRef<LeaveGuardState>(initialLeaveGuard);
  const effectRef = useRef(onEffect);
  useEffect(() => {
    effectRef.current = onEffect;
  });

  useEffect(() => {
    stateRef.current = initialLeaveGuard;
    if (!active) {
      return undefined;
    }
    const activatedAt = Date.now();
    const sample = (): void => {
      const now = Date.now();
      const present = userIsPresent() || now - activatedAt < SETTLE_MS;
      const result = stepLeaveGuard(stateRef.current, { nowMs: now, present });
      stateRef.current = result.state;
      setState(result.state);
      setNowMs(now);
      if (result.effect !== 'none') {
        effectRef.current(result.effect);
      }
    };
    sample();
    const events = ['visibilitychange', 'fullscreenchange'] as const;
    for (const event of events) {
      document.addEventListener(event, sample);
    }
    window.addEventListener('blur', sample);
    window.addEventListener('focus', sample);
    const timer = setInterval(sample, SAMPLE_EVERY_MS);
    return () => {
      for (const event of events) {
        document.removeEventListener(event, sample);
      }
      window.removeEventListener('blur', sample);
      window.removeEventListener('focus', sample);
      clearInterval(timer);
    };
  }, [active]);

  // A paused (inactive) guard shows nothing, whatever it held before.
  return { state: active ? state : initialLeaveGuard, nowMs };
}

export function DeepFocusScreen({ session }: { readonly session: InProgress }) {
  const serverNowMs = useServerNowMs();
  const pause = usePauseFocusSession();
  const resume = useResumeFocusSession();
  const stop = useStopFocusSession();
  const breakSession = useBreakFocusSession();
  const distraction = useRecordFocusDistraction();
  const playing = usePlayingSounds();
  const [soundsOpen, setSoundsOpen] = useState(false);

  const deep = session.deepFocus ?? { distractions: 0, pausesUsed: 0 };
  const paused = session.runningSince === null;
  const focused = focusedSecondsAt(session, serverNowMs);
  const remaining = remainingSecondsAt(session, serverNowMs);
  const pending = pause.isPending || resume.isPending || stop.isPending || breakSession.isPending;
  const error = pause.error ?? resume.error ?? stop.error ?? breakSession.error;
  const pauseLeftToUse = deep.pausesUsed < DEEP_FOCUS_PAUSES_ALLOWED;

  // Leaving only counts while the session runs: a pause is explicitly allowed time away.
  const guarded = !paused && remaining > 0 && !breakSession.isPending;
  const { state: guard, nowMs } = useLeaveGuard(guarded, (effect) => {
    if (effect === 'break') {
      breakSession.mutate(session.id);
    } else {
      distraction.mutate(session.id);
    }
  });
  const away = guarded && guard.awaySinceMs !== null;

  // Keep the screen on while it is shown; leave full screen and the sound when it ends.
  useEffect(() => keepScreenAwake(), []);
  useEffect(
    () => () => {
      exitFullscreen();
      stopAllSounds();
    },
    [],
  );

  const pauseNowMs = usePauseClock(paused);
  const pauseStartedAt = pauseStartOf(session.id, paused);
  const pauseLeft =
    pauseStartedAt === null
      ? DEEP_FOCUS_PAUSE_SECONDS
      : Math.max(
          0,
          DEEP_FOCUS_PAUSE_SECONDS - Math.floor(Math.max(0, pauseNowMs - pauseStartedAt) / 1_000),
        );

  return (
    <Screen>
      <p className="text-xs tracking-[0.35em] text-white/40 uppercase">Deep Focus</p>
      <p className="font-display max-w-xl text-3xl leading-snug text-white">
        {session.task?.title ?? 'Stay with it'}
      </p>

      <ProgressRing progress={focused / session.plannedSeconds} muted={paused}>
        <p className="font-display text-7xl text-white tabular-nums">
          <span className="sr-only">Time remaining </span>
          {formatClock(remaining)}
        </p>
        <p role="status" className="mt-2 text-sm text-white/50">
          {paused ? 'Paused' : remaining === 0 ? 'Finishing…' : 'Breathe. One thing.'}
        </p>
      </ProgressRing>

      <p className="text-xs text-white/40">
        {deep.distractions === 0
          ? 'No distractions so far'
          : `${String(deep.distractions)} ${deep.distractions === 1 ? 'distraction' : 'distractions'}`}
      </p>

      {paused ? (
        <div className="space-y-3">
          <p className="text-sm text-white/70">
            {pauseLeft > 0
              ? `Your pause: ${formatClock(pauseLeft)} left. You may leave the tab until you resume.`
              : 'Your pause is over. Resume, or end the session.'}
          </p>
          <button
            type="button"
            disabled={pending}
            className={BRIGHT_BUTTON}
            onClick={() => {
              enterFullscreen();
              resume.mutate(session.id);
            }}
          >
            {resume.isPending ? 'Resuming…' : 'Resume'}
          </button>
        </div>
      ) : (
        <div className="w-full max-w-md">
          <ParkThought sessionId={session.id} />
        </div>
      )}

      <div className="flex flex-wrap items-center justify-center gap-3">
        {!paused && (
          <button
            type="button"
            disabled={pending || !pauseLeftToUse}
            className={LIGHT_BUTTON}
            onClick={() => {
              pause.mutate(session.id);
            }}
          >
            {pauseLeftToUse
              ? `Pause (once, up to ${String(DEEP_FOCUS_PAUSE_SECONDS / 60)} min)`
              : 'Pause used'}
          </button>
        )}
        <HoldToEnd
          disabled={pending}
          onComplete={() => {
            stop.mutate(session.id);
          }}
        />
        <button
          type="button"
          aria-expanded={soundsOpen}
          aria-controls="deep-focus-sounds"
          className={LIGHT_BUTTON}
          onClick={() => {
            setSoundsOpen((open) => !open);
          }}
        >
          {playing.length === 0 ? 'Focus sounds' : `Sounds (${String(playing.length)} on)`}
        </button>
      </div>

      {soundsOpen && (
        <div id="deep-focus-sounds" className="w-full max-w-xl">
          <SoundPicker tone="dark" />
        </div>
      )}

      {error !== null && (
        <p role="alert" className="text-sm text-red-300">
          {focusErrorMessage(error)}
        </p>
      )}

      {away && (
        <div
          role="alertdialog"
          aria-modal="true"
          aria-label="You left Deep Focus"
          className="fixed inset-0 z-[110] flex flex-col items-center justify-center gap-5 bg-[#1a0606]/95 px-4 text-center text-white"
        >
          <p className="font-display text-8xl tabular-nums">{secondsLeft(guard, nowMs)}</p>
          <p className="max-w-sm text-lg">
            You left Deep Focus. Come back now, or this session resets.
          </p>
          {fullscreenSupported() && (
            <button type="button" className={BRIGHT_BUTTON} onClick={enterFullscreen}>
              Back to full screen
            </button>
          )}
        </div>
      )}
    </Screen>
  );
}

/** Ending takes a deliberate 3-second hold, so an impulse is not enough to quit. */
function HoldToEnd({
  disabled,
  onComplete,
}: {
  readonly disabled: boolean;
  readonly onComplete: () => void;
}) {
  const [holding, setHolding] = useState(false);
  const completeRef = useRef(onComplete);
  useEffect(() => {
    completeRef.current = onComplete;
  });
  useEffect(() => {
    if (!holding) {
      return undefined;
    }
    const timer = setTimeout(() => {
      setHolding(false);
      completeRef.current();
    }, HOLD_TO_END_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [holding]);

  const release = (): void => {
    setHolding(false);
  };
  return (
    <>
      <span id="deep-focus-hold-hint" className="sr-only">
        Press and hold for 3 seconds to end the session.
      </span>
      <button
        type="button"
        disabled={disabled}
        aria-describedby="deep-focus-hold-hint"
        className={`${LIGHT_BUTTON} relative overflow-hidden`}
        onPointerDown={() => {
          setHolding(true);
        }}
        onPointerUp={release}
        onPointerLeave={release}
        onPointerCancel={release}
        onKeyDown={(event) => {
          if ((event.key === ' ' || event.key === 'Enter') && !event.repeat) {
            event.preventDefault();
            setHolding(true);
          }
        }}
        onKeyUp={(event) => {
          if (event.key === ' ' || event.key === 'Enter') {
            release();
          }
        }}
      >
        <span
          aria-hidden="true"
          className="absolute inset-y-0 left-0 bg-white/20"
          style={{
            width: holding ? '100%' : '0%',
            transition: holding
              ? `width ${String(HOLD_TO_END_MS)}ms linear`
              : 'width 150ms ease-out',
          }}
        />
        <span className="relative">{holding ? 'Keep holding…' : 'Hold to end'}</span>
      </button>
    </>
  );
}
