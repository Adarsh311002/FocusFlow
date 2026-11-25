import {
  PARKED_THOUGHTS_MAX,
  type ParkedThoughtView,
  parkedThoughtViewSchema,
  type TaskView,
} from '@focus-flow/contracts';
import { and, count, desc, eq } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';

import type { Db } from '../../db/client.js';
import { focusSessions, parkedThoughts, users } from '../../db/schema.js';
import { AppError } from '../../platform/http/errors.js';
import { insertTask } from '../tasks/queries.js';
import { toTaskView } from '../tasks/views.js';

// Parked thoughts (PT1–PT4): PostgreSQL only, always scoped to the authenticated user.
// Another user's and an unknown thought (or session) answer the same 404, so ids reveal
// nothing.

export type ParkedThoughtsDeps = { readonly db: Db };

type ThoughtRow = typeof parkedThoughts.$inferSelect;

const notFound = (): AppError => new AppError('NOT_FOUND', 404, 'Parked thought not found.');

const toView = (row: ThoughtRow): ParkedThoughtView =>
  parkedThoughtViewSchema.parse({
    id: row.id,
    body: row.body,
    sessionId: row.sessionId,
    createdAt: row.createdAt.toISOString(),
  });

const ownedBy = (userId: string, thoughtId: string) =>
  and(eq(parkedThoughts.id, thoughtId), eq(parkedThoughts.userId, userId));

/** Every open thought, newest first (UUIDv7 ids), served by `ix_parked_thoughts_user_id_id`. */
export const listParkedThoughts = async (
  deps: ParkedThoughtsDeps,
  userId: string,
): Promise<ParkedThoughtView[]> => {
  const rows = await deps.db
    .select()
    .from(parkedThoughts)
    .where(eq(parkedThoughts.userId, userId))
    .orderBy(desc(parkedThoughts.id))
    .limit(PARKED_THOUGHTS_MAX);
  return rows.map(toView);
};

/**
 * PT2: parks a thought. The optional session must be the user's own (404 otherwise). The
 * user row is locked for the transaction, so two simultaneous adds cannot both slip past
 * the PARKED_THOUGHTS_MAX check (`409 THOUGHTS_FULL`).
 */
export const parkThought = (
  deps: ParkedThoughtsDeps,
  userId: string,
  input: { readonly body: string; readonly sessionId?: string | undefined },
): Promise<ParkedThoughtView> =>
  deps.db.transaction(async (tx) => {
    await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for('update');
    if (input.sessionId !== undefined) {
      const [session] = await tx
        .select({ id: focusSessions.id })
        .from(focusSessions)
        .where(and(eq(focusSessions.id, input.sessionId), eq(focusSessions.userId, userId)))
        .limit(1);
      if (session === undefined) {
        throw new AppError('NOT_FOUND', 404, 'Focus session not found.');
      }
    }
    const [held] = await tx
      .select({ total: count() })
      .from(parkedThoughts)
      .where(eq(parkedThoughts.userId, userId));
    if ((held?.total ?? 0) >= PARKED_THOUGHTS_MAX) {
      throw new AppError(
        'THOUGHTS_FULL',
        409,
        'You have many parked thoughts. Turn some into tasks or let them go first.',
      );
    }
    const [row] = await tx
      .insert(parkedThoughts)
      .values({ id: uuidv7(), userId, sessionId: input.sessionId ?? null, body: input.body })
      .returning();
    if (row === undefined) {
      throw new Error('parkThought: insert returned no row');
    }
    return toView(row);
  });

/** PT4: lets a thought go. Another user's or an unknown one is 404. */
export const dismissThought = async (
  deps: ParkedThoughtsDeps,
  userId: string,
  thoughtId: string,
): Promise<void> => {
  const removed = await deps.db
    .delete(parkedThoughts)
    .where(ownedBy(userId, thoughtId))
    .returning({ id: parkedThoughts.id });
  if (removed.length === 0) {
    throw notFound();
  }
};

/**
 * PT3: the thought becomes an open task with the same text, and is removed, in one
 * transaction: a retry after a lost answer finds no thought (404) rather than making a
 * second task. The task is not made current (the user decides that).
 */
export const thoughtToTask = (
  deps: ParkedThoughtsDeps,
  userId: string,
  thoughtId: string,
): Promise<TaskView> =>
  deps.db.transaction(async (tx) => {
    const [thought] = await tx.delete(parkedThoughts).where(ownedBy(userId, thoughtId)).returning();
    if (thought === undefined) {
      throw notFound();
    }
    return toTaskView(await insertTask(tx, { id: uuidv7(), userId, title: thought.body }));
  });
