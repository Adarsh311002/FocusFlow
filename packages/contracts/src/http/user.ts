import { z } from 'zod';

import { userIdSchema } from '../ids';

/**
 * The identity providers a user may have linked. Only 'google' exists in the
 * domain (D1); it is listed here because the shape is part of the approved
 * contract (docs/api/rest.md), even though nothing populates it before Phase 1b.
 */
export const identityProviderSchema = z.enum(['google']);
export type IdentityProvider = z.infer<typeof identityProviderSchema>;

/**
 * `currentTaskId` is part of the approved UserView (docs/api/rest.md) but the
 * `tasks` table does not exist until Phase 2, so it is omitted here rather than
 * faked. Phase 2 adds it alongside the schema column that backs it.
 */
export const userViewSchema = z.object({
  id: userIdSchema,
  email: z.email(),
  emailVerified: z.boolean(),
  displayName: z.string().min(1).max(50),
  avatarUrl: z.url().nullable(),
  identities: z.array(identityProviderSchema),
});
export type UserView = z.infer<typeof userViewSchema>;

/** `GET /me` response envelope (docs/api/rest.md). */
export const meResponseSchema = z.object({ user: userViewSchema });
export type MeResponse = z.infer<typeof meResponseSchema>;
