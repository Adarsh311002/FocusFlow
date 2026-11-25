import { z } from 'zod';

import { taskIdSchema, userIdSchema } from '../ids';

/**
 * The identity providers a user may have linked. Only 'google' exists in the
 * domain (D1); it is listed here because the shape is part of the approved
 * contract (docs/api/rest.md), even though nothing populates it before Phase 1b.
 */
export const identityProviderSchema = z.enum(['google']);
export type IdentityProvider = z.infer<typeof identityProviderSchema>;

/** The daily focus goal in whole seconds: 5 minutes to 12 hours, default 2 hours (A2). */
export const DAILY_GOAL_SECONDS = { min: 300, max: 43_200, default: 7_200 } as const;

export const dailyGoalSecondsSchema = z
  .number()
  .int()
  .min(DAILY_GOAL_SECONDS.min)
  .max(DAILY_GOAL_SECONDS.max);

/** ST2: the forest-animal avatars a user may choose; `null` shows their initial. */
export const avatarPresetSchema = z.enum([
  'monkey',
  'sloth',
  'toucan',
  'frog',
  'owl',
  'butterfly',
  'jaguar',
]);
export type AvatarPreset = z.infer<typeof avatarPresetSchema>;

/** ST3: the session length the start form opens with, in seconds (E1 limits); default 25 min. */
export const DEFAULT_SESSION_SECONDS = 1_500;

/**
 * `currentTaskId` (D3) is `null` or the id of one of the user's own open,
 * non-deleted tasks; completing or deleting that task clears it (D38, D43).
 */
export const userViewSchema = z.object({
  id: userIdSchema,
  email: z.email(),
  emailVerified: z.boolean(),
  displayName: z.string().min(1).max(50),
  avatarUrl: z.url().nullable(),
  currentTaskId: taskIdSchema.nullable(),
  /**
   * The daily focus goal (A2). The API always sends it; it is optional only so that older
   * fixtures and cached responses still parse, and a client reads a missing one as
   * `DAILY_GOAL_SECONDS.default`.
   */
  dailyGoalSeconds: dailyGoalSecondsSchema.optional(),
  /** ST2; optional like the goal, so older fixtures parse (missing = none). */
  avatarPreset: avatarPresetSchema.nullable().optional(),
  /** ST3; optional like the goal (missing = `DEFAULT_SESSION_SECONDS`). */
  defaultSessionSeconds: z.number().int().min(60).max(14_400).optional(),
  identities: z.array(identityProviderSchema),
});
export type UserView = z.infer<typeof userViewSchema>;

/** `GET /me` and `PUT /me/current-task` response envelope (docs/api/rest.md). */
export const meResponseSchema = z.object({ user: userViewSchema });
export type MeResponse = z.infer<typeof meResponseSchema>;

/** `PATCH /me`: the user's own settings; at least one field, unknown keys rejected. */
export const updateMeRequestSchema = z
  .strictObject({
    dailyGoalSeconds: dailyGoalSecondsSchema.optional(),
    /** ST1: trimmed, 1–50 characters, like sign-up. */
    displayName: z.string().trim().min(1).max(50).optional(),
    /** ST2: `null` goes back to the initial. */
    avatarPreset: avatarPresetSchema.nullable().optional(),
    /** ST3: whole minutes in seconds, 60–14,400 (E1). */
    defaultSessionSeconds: z
      .number()
      .int()
      .min(60)
      .max(14_400)
      .refine((seconds) => seconds % 60 === 0, { message: 'Whole minutes only.' })
      .optional(),
  })
  .refine((value) => Object.values(value).some((entry) => entry !== undefined), {
    message: 'Give at least one setting.',
  });
export type UpdateMeRequest = z.infer<typeof updateMeRequestSchema>;
