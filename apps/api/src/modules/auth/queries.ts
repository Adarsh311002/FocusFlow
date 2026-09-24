import { and, eq, isNull, sql } from 'drizzle-orm';

import type { Db, Executor } from '../../db/client.js';
import { authIdentities, authSessions, users } from '../../db/schema.js';

export type UserRow = typeof users.$inferSelect;
export type AuthSessionRow = typeof authSessions.$inferSelect;

export const findUserByEmail = async (db: Db, email: string): Promise<UserRow | undefined> => {
  const [row] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  return row;
};

export const findUserById = async (db: Db, id: string): Promise<UserRow | undefined> => {
  const [row] = await db.select().from(users).where(eq(users.id, id)).limit(1);
  return row;
};

export type NewUser = {
  id: string;
  email: string;
  displayName: string;
  passwordHash: string;
  emailVerifiedAt: Date | null;
};

export const insertUser = async (db: Executor, values: NewUser): Promise<UserRow> => {
  const [row] = await db.insert(users).values(values).returning();
  if (row === undefined) {
    throw new Error('insertUser: insert returned no row');
  }
  return row;
};

/** The identity providers linked to a user (empty until Phase 1b links any). */
export const findLinkedProviders = async (db: Db, userId: string): Promise<string[]> => {
  const rows = await db
    .select({ provider: authIdentities.provider })
    .from(authIdentities)
    .where(eq(authIdentities.userId, userId));
  return rows.map((row) => row.provider);
};

export type NewAuthSession = {
  id: string;
  userId: string;
  currentTokenHash: string;
  expiresAt: Date;
};

export const insertAuthSession = async (
  db: Executor,
  values: NewAuthSession,
): Promise<AuthSessionRow> => {
  const [row] = await db.insert(authSessions).values(values).returning();
  if (row === undefined) {
    throw new Error('insertAuthSession: insert returned no row');
  }
  return row;
};

export const findAuthSessionById = async (
  db: Db,
  id: string,
): Promise<AuthSessionRow | undefined> => {
  const [row] = await db.select().from(authSessions).where(eq(authSessions.id, id)).limit(1);
  return row;
};

/**
 * Atomic compare-and-swap rotation: succeeds only if `currentTokenHash` still equals
 * `expectedCurrentHash` at the moment PostgreSQL applies the UPDATE. `previousTokenHash`
 * is set from the row's OWN pre-update `currentTokenHash` column (not the JS value),
 * since PostgreSQL evaluates every SET expression against the row as it was before
 * this statement — this is what makes the shift-and-replace atomic. If two requests
 * race, only the one whose guard still matches succeeds; the other gets `undefined`
 * back and the caller re-reads the (now-updated) row to decide what happened
 * (see modules/auth/refresh-decision.ts).
 */
export const rotateAuthSession = async (
  db: Db,
  sid: string,
  expectedCurrentHash: string,
  newCurrentHash: string,
  previousValidUntil: Date,
): Promise<AuthSessionRow | undefined> => {
  const now = new Date();
  const [row] = await db
    .update(authSessions)
    .set({
      previousTokenHash: sql`${authSessions.currentTokenHash}`,
      currentTokenHash: newCurrentHash,
      previousValidUntil,
      rotatedAt: now,
      lastUsedAt: now,
    })
    .where(
      and(
        eq(authSessions.id, sid),
        eq(authSessions.currentTokenHash, expectedCurrentHash),
        isNull(authSessions.revokedAt),
      ),
    )
    .returning();
  return row;
};

export const touchAuthSessionLastUsed = async (db: Db, sid: string): Promise<void> => {
  await db.update(authSessions).set({ lastUsedAt: new Date() }).where(eq(authSessions.id, sid));
};

/** Idempotent: revoking an already-revoked session changes nothing. */
export const revokeAuthSession = async (db: Db, sid: string): Promise<void> => {
  await db
    .update(authSessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(authSessions.id, sid), isNull(authSessions.revokedAt)));
};
