import type { BuddyNudgeEvent, UpcomingSession } from '@focus-flow/contracts';
import { Link } from '@tanstack/react-router';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useState } from 'react';

import { useAuth } from '../auth/auth-context';
import { useOptionalRealtimeClient } from '../realtime/realtime-provider';
import { useUpcomingSessions } from './together-data';

// The live side of focusing with others: a buddy's nudge (BD5) and the reminder for a
// scheduled room session (SC4). Both are gentle notes; neither starts anything.

const NUDGE_FOR_MS = 10_000;
/** SC4: a session is announced from this long before it starts until it ends. */
export const REMIND_BEFORE_MS = 15 * 60_000;

/**
 * `held` (DF5): a Deep Focus session is running. A nudge that arrives meanwhile is kept and
 * shown once it ends; the reminder banner waits too.
 */
export function TogetherNotices({ held = false }: { readonly held?: boolean }) {
  const { status } = useAuth();
  if (status !== 'authenticated') {
    return null;
  }
  return (
    <>
      <NudgeNote held={held} />
      {!held && <UpcomingBanner />}
    </>
  );
}

function NudgeNote({ held }: { readonly held: boolean }) {
  const client = useOptionalRealtimeClient();
  const [nudge, setNudge] = useState<BuddyNudgeEvent | null>(null);

  useEffect(() => {
    if (client === null) {
      return undefined;
    }
    return client.onBuddyNudge?.((event) => {
      setNudge(event);
    });
  }, [client]);

  useEffect(() => {
    if (nudge === null || held) {
      return undefined;
    }
    const timer = setTimeout(() => {
      setNudge(null);
    }, NUDGE_FOR_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [nudge, held]);

  return (
    <AnimatePresence>
      {nudge !== null && !held && (
        <motion.div
          role="status"
          initial={{ opacity: 0, y: -16 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -10 }}
          className="fixed top-24 left-1/2 z-[70] flex w-[min(92vw,26rem)] -translate-x-1/2 items-center gap-4 rounded-2xl border border-focus/40 bg-canvas-2/95 p-4 shadow-card backdrop-blur-xl"
        >
          <span aria-hidden="true" className="text-3xl">
            👋
          </span>
          <p className="min-w-0 flex-1">
            <strong className="font-medium">{nudge.displayName}</strong> nudged you. Time for a
            session together?
          </p>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => {
              setNudge(null);
            }}
            className="text-muted hover:text-ink"
          >
            ×
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/** "starts in 8 min" or "under way". */
export function whenLabel(session: UpcomingSession, nowMs: number): string {
  const startMs = Date.parse(session.startsAt);
  if (startMs <= nowMs) {
    return 'under way now';
  }
  const minutes = Math.max(1, Math.round((startMs - nowMs) / 60_000));
  return `starts in ${String(minutes)} min`;
}

function UpcomingBanner() {
  const upcoming = useUpcomingSessions();
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [dismissed, setDismissed] = useState<readonly string[]>([]);

  useEffect(() => {
    const timer = setInterval(() => {
      setNowMs(Date.now());
    }, 30_000);
    return () => {
      clearInterval(timer);
    };
  }, []);

  const soon = (upcoming.data ?? []).find((session) => {
    const startMs = Date.parse(session.startsAt);
    return (
      startMs - nowMs <= REMIND_BEFORE_MS &&
      startMs + session.durationMinutes * 60_000 > nowMs &&
      !dismissed.includes(`${session.scheduleId}:${session.startsAt}`)
    );
  });
  if (soon === undefined) {
    return null;
  }
  return (
    <div
      role="status"
      className="fixed right-4 bottom-20 z-[60] flex w-[min(92vw,24rem)] items-center gap-3 rounded-2xl border border-focus/40 bg-canvas-2/95 p-4 shadow-card backdrop-blur-xl"
    >
      <span aria-hidden="true" className="text-2xl">
        🕯️
      </span>
      <div className="min-w-0 flex-1 text-sm">
        <p className="font-medium">{`${soon.title} ${whenLabel(soon, nowMs)}`}</p>
        <Link
          to="/rooms/$roomId"
          params={{ roomId: soon.roomId }}
          className="text-focus underline underline-offset-4"
        >
          {`Go to ${soon.roomName}`}
        </Link>
      </div>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={() => {
          setDismissed((current) => [...current, `${soon.scheduleId}:${soon.startsAt}`]);
        }}
        className="text-muted hover:text-ink"
      >
        ×
      </button>
    </div>
  );
}
