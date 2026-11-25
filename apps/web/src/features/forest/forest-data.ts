import {
  type ForestCreature,
  type ForestMilestoneId,
  forestPaths,
  forestResponseSchema,
} from '@focus-flow/contracts';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import { authedApiRequest } from '../auth/auth-client';
import { useAuth } from '../auth/auth-context';
import { readBrowserTimeZone, resolveTimeZone } from '../review/review-range';

// "Grow your forest" on the web (GF6). The forest lives under the focus-session keys, so a
// `focus:session:updated` event (a session ended, a check-in) regrows it like Review (W2).

const NO_USER = 'signed-out';

export function useForest() {
  const userId = useAuth().user?.id ?? NO_USER;
  const [tz] = useState(() => resolveTimeZone(readBrowserTimeZone()).timeZone);
  return useQuery({
    queryKey: ['focus-sessions', userId, 'forest', tz] as const,
    queryFn: () =>
      authedApiRequest(`${forestPaths.self}?tz=${encodeURIComponent(tz)}`, forestResponseSchema),
    enabled: userId !== NO_USER,
  });
}

export const CREATURE: Readonly<Record<ForestCreature, { emoji: string; name: string }>> = {
  firefly: { emoji: '✨', name: 'Fireflies' },
  frog: { emoji: '🐸', name: 'A frog' },
  butterfly: { emoji: '🦋', name: 'A butterfly' },
  toucan: { emoji: '🦜', name: 'A toucan' },
  owl: { emoji: '🦉', name: 'An owl' },
  sloth: { emoji: '🦥', name: 'A sloth' },
  monkey: { emoji: '🐒', name: 'A monkey' },
  jaguar: { emoji: '🐆', name: 'A jaguar' },
};

/** What each milestone asks, and the unit of its progress. */
export const MILESTONE_TEXT: Readonly<
  Record<ForestMilestoneId, { title: string; description: string; unit: string }>
> = {
  'first-seed': {
    title: 'The first seed',
    description: 'Complete your first session.',
    unit: 'session',
  },
  'ten-sessions': {
    title: 'A small grove',
    description: 'Complete 10 sessions.',
    unit: 'sessions',
  },
  'ten-hours': { title: 'Ten deep hours', description: 'Focus for 10 hours in all.', unit: 'h' },
  'week-streak': {
    title: 'A week of roots',
    description: 'Complete a session on 7 days in a row.',
    unit: 'days',
  },
  'intentions-25': {
    title: 'Promises kept',
    description: 'Check in "Done" on 25 intentions.',
    unit: 'done',
  },
  'deep-flow': {
    title: 'Deep flow',
    description: 'Rate a session 5: deep flow.',
    unit: 'session',
  },
  together: {
    title: 'Side by side',
    description: 'Complete a focus run in a room.',
    unit: 'run',
  },
  'hundred-hours': {
    title: 'An old forest',
    description: 'Focus for 100 hours in all.',
    unit: 'h',
  },
};
