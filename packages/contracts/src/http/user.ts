import { z } from 'zod';

import { taskIdSchema, userIdSchema } from '../ids';

/**
 * The identity providers a user may have linked. Only 'google' exists in the
 * domain (D1); it is listed here because the shape is part of the approved
 * contract (docs/api/rest.md), even though nothing populates it before Phase 1b.
 */
export const identityProviderSchema = z.enum(['google']);
export type IdentityProvider = z.infer<typeof identityProviderSchema>;

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
  identities: z.array(identityProviderSchema),
});
export type UserView = z.infer<typeof userViewSchema>;

/** `GET /me` and `PUT /me/current-task` response envelope (docs/api/rest.md). */
export const meResponseSchema = z.object({ user: userViewSchema });
export type MeResponse = z.infer<typeof meResponseSchema>;
