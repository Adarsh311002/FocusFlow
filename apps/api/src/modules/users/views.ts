import { identityProviderSchema, userIdSchema, type UserView } from '@focus-flow/contracts';
import { z } from 'zod';

import type { Db } from '../../db/client.js';
import { findLinkedProviders, type UserRow } from '../auth/queries.js';

const identityProvidersSchema = z.array(identityProviderSchema);

/**
 * Persistence (`UserRow`) never becomes the API response directly (F3): every field
 * is mapped explicitly, and identifiers are re-validated through the contract's
 * branded schema rather than cast.
 */
export const toUserView = async (db: Db, user: UserRow): Promise<UserView> => {
  const providers = await findLinkedProviders(db, user.id);

  return {
    id: userIdSchema.parse(user.id),
    email: user.email,
    emailVerified: user.emailVerifiedAt !== null,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
    identities: identityProvidersSchema.parse(providers),
  };
};
