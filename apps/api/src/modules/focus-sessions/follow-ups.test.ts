import type { FocusSessionView } from '@focus-flow/contracts';
import { describe, expect, it } from 'vitest';

import type { FocusSessionChange, FocusSessionTransition } from './changes.js';
import { followUpChange } from './follow-ups.js';
import type { FocusSessionScheduler } from './lifecycle.js';
import type { ClearRule } from './marker.js';
import type { DisconnectMarkerStore } from './marker-store.js';

// What each committed transition triggers (E10: every marker clear is ownership-checked;
// a resume clears only a marker from before its new stretch).

const SESSION = '01a0ed0d-55de-7d1b-8495-82fb5050d815';
const USER = '01a0ed0d-55de-7d1b-8495-82fb5050d816';

const recorder = () => {
  const ends: unknown[] = [];
  const clears: ClearRule[] = [];
  const scheduler: FocusSessionScheduler = {
    scheduleEnd: (job) => {
      ends.push(job);
      return Promise.resolve();
    },
    scheduleGrace: () => Promise.reject(new Error('not expected')),
  };
  const markers = {
    clear: (_userId: string, rule: ClearRule) => {
      clears.push(rule);
      return Promise.resolve(true);
    },
  } as unknown as DisconnectMarkerStore;
  return { ends, clears, deps: { scheduler, markers } };
};

const change = (
  transition: FocusSessionTransition,
  runningStretch: FocusSessionChange['runningStretch'] = null,
): FocusSessionChange => ({
  userId: USER,
  transition,
  session: { id: SESSION } as unknown as FocusSessionView,
  runningStretch,
});

describe('followUpChange', () => {
  it('start: schedules the end job and clears nothing', async () => {
    const { ends, clears, deps } = recorder();
    await followUpChange(deps, change('started', { runningSinceMs: 1_000, plannedEndMs: 61_000 }));
    expect(ends).toEqual([
      { sessionId: SESSION, userId: USER, runningSinceMs: 1_000, plannedEndMs: 61_000 },
    ]);
    expect(clears).toEqual([]);
  });

  it('resume: schedules the new end job and clears only a marker from before the stretch', async () => {
    const { ends, clears, deps } = recorder();
    await followUpChange(deps, change('resumed', { runningSinceMs: 5_000, plannedEndMs: 50_000 }));
    expect(ends).toHaveLength(1);
    expect(clears).toEqual([{ kind: 'stale', sessionId: SESSION, runningSinceMs: 5_000 }]);
  });

  it.each(['paused', 'stopped', 'completed', 'grace_expired', 'expired'] as const)(
    '%s: clears this session’s marker (ownership-checked) and schedules nothing',
    async (transition) => {
      const { ends, clears, deps } = recorder();
      await followUpChange(deps, change(transition));
      expect(ends).toEqual([]);
      expect(clears).toEqual([{ kind: 'session', sessionId: SESSION }]);
    },
  );
});
