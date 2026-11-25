import { z } from 'zod';

import { timeZoneSchema } from '../dates';
import { focusSessionIdSchema } from '../ids';

// "Grow your forest" (GF1–GF6, docs/decisions/decision-log.md): the user's focus history drawn
// as a forest. Nothing here is stored: the server derives it from the sessions, check-ins and
// days already recorded, so it can never disagree with them.

/** At most this many of the newest plants are sent; the totals count everything. */
export const FOREST_MAX_PLANTS = 240;

/** GF2: a plant's size follows the session it grew from. */
export const plantKindSchema = z.enum(['sprout', 'sapling', 'tree']);
export type PlantKind = z.infer<typeof plantKindSchema>;

export const forestPlantSchema = z.object({
  /** The session it grew from: also the seed of its place in the forest. */
  id: focusSessionIdSchema,
  kind: plantKindSchema,
  /** The session was checked in as done (CI1). */
  bloom: z.boolean(),
  /** The session was rated deep (quality 4–5, FQ1). */
  glow: z.boolean(),
  plantedAt: z.iso.datetime(),
});
export type ForestPlant = z.infer<typeof forestPlantSchema>;

/** GF3: the creatures milestones bring into the forest. */
export const forestCreatureSchema = z.enum([
  'firefly',
  'frog',
  'butterfly',
  'toucan',
  'owl',
  'sloth',
  'monkey',
  'jaguar',
]);
export type ForestCreature = z.infer<typeof forestCreatureSchema>;

export const forestMilestoneIdSchema = z.enum([
  'first-seed',
  'ten-sessions',
  'ten-hours',
  'week-streak',
  'intentions-25',
  'deep-flow',
  'together',
  'hundred-hours',
]);
export type ForestMilestoneId = z.infer<typeof forestMilestoneIdSchema>;

export const forestMilestoneSchema = z.object({
  id: forestMilestoneIdSchema,
  creature: forestCreatureSchema,
  /** How far along it is, in the milestone's own unit (sessions, hours, days…). */
  current: z.number().nonnegative(),
  target: z.number().positive(),
  /** When the session that reached it ended; `null` while locked. */
  unlockedAt: z.iso.datetime().nullable(),
});
export type ForestMilestone = z.infer<typeof forestMilestoneSchema>;

export const forestResponseSchema = z.object({
  totals: z.object({
    plants: z.number().int().nonnegative(),
    completedSessions: z.number().int().nonnegative(),
    focusedSeconds: z.number().int().nonnegative(),
    intentionsDone: z.number().int().nonnegative(),
    deepSessions: z.number().int().nonnegative(),
    currentStreak: z.number().int().nonnegative(),
    longestStreak: z.number().int().nonnegative(),
  }),
  /**
   * GF4: how lively the forest looks, from the last 7 local days' focus against the daily
   * goal. Never below 0.15: a quiet forest rests, it never dies.
   */
  vitality: z.number().min(0.15).max(1),
  /** The newest plants (at most FOREST_MAX_PLANTS), oldest first. */
  plants: z.array(forestPlantSchema).max(FOREST_MAX_PLANTS),
  milestones: z.array(forestMilestoneSchema),
});
export type ForestResponse = z.infer<typeof forestResponseSchema>;

/** `GET /forest?tz=`: days and streaks are counted in this zone (V5 rules). */
export const forestQuerySchema = z.strictObject({ tz: timeZoneSchema });
