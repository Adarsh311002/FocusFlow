import { randomInt } from 'node:crypto';

import {
  BUDDIES_MAX,
  type BuddiesResponse,
  buddiesResponseSchema,
  BUDDY_CODE_LENGTH,
  type BuddyNudgeEvent,
  ROOM_CODE_ALPHABET,
} from '@focus-flow/contracts';
import { and, count, eq, inArray, isNotNull, isNull, ne, or, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';

import type { Db } from '../../db/client.js';
import { isUniqueViolation } from '../../db/pg-errors.js';
import { buddyLinks, focusSessions, users } from '../../db/schema.js';
import { AppError } from '../../platform/http/errors.js';
import { computeStreak, createLocalMomentFormatter } from '../focus-sessions/insights.js';

// Focus buddies (BD1–BD4). A buddy sees your streak, your focus of the last 7 days and
// whether you are focusing now; never tasks, notes or check-ins. PostgreSQL only.

export type BuddiesDeps = {
  readonly db: Db;
  /** BD4: sends `buddy:nudge` to every tab of the user (the socket emitter). */
  readonly notify: (userId: string, event: BuddyNudgeEvent) => void;
  /** BD4: one nudge per buddy per hour; false when refused. */
  readonly allowNudge: (fromUserId: string, toUserId: string) => Promise<boolean>;
  readonly nowMs?: () => number;
};

const generateBuddyCode = (): string =>
  Array.from({ length: BUDDY_CODE_LENGTH }, () =>
    ROOM_CODE_ALPHABET.charAt(randomInt(ROOM_CODE_ALPHABET.length)),
  ).join('');

/** BD1: the user's code, made on first use (a clash with another user's retries). */
const codeOf = async (db: Db, userId: string): Promise<string> => {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const [row] = await db
      .select({ code: users.buddyCode })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (row?.code !== null && row?.code !== undefined) {
      return row.code;
    }
    try {
      await db
        .update(users)
        .set({ buddyCode: generateBuddyCode() })
        .where(and(eq(users.id, userId), isNull(users.buddyCode)));
    } catch (error) {
      if (!isUniqueViolation(error)) {
        throw error;
      }
    }
  }
  throw new Error('codeOf: could not create a buddy code');
};

const pairWith = (a: string, b: string) =>
  or(
    and(eq(buddyLinks.requesterId, a), eq(buddyLinks.addresseeId, b)),
    and(eq(buddyLinks.requesterId, b), eq(buddyLinks.addresseeId, a)),
  );

const linksOf = (userId: string) =>
  or(eq(buddyLinks.requesterId, userId), eq(buddyLinks.addresseeId, userId));

export const getBuddies = async (
  deps: BuddiesDeps,
  userId: string,
  tz: string,
): Promise<BuddiesResponse> => {
  const code = await codeOf(deps.db, userId);
  const links = await deps.db.select().from(buddyLinks).where(linksOf(userId));
  const otherOf = (link: (typeof links)[number]) =>
    link.requesterId === userId ? link.addresseeId : link.requesterId;
  const ids = links.map(otherOf);
  const profiles =
    ids.length === 0
      ? []
      : await deps.db
          .select({
            id: users.id,
            displayName: users.displayName,
            avatarPreset: users.avatarPreset,
          })
          .from(users)
          .where(inArray(users.id, ids));
  const profile = (id: string) => profiles.find((entry) => entry.id === id);

  const accepted = links.filter((link) => link.acceptedAt !== null).map(otherOf);
  const nowMs = (deps.nowMs ?? Date.now)();
  const weekAgo = new Date(nowMs - 7 * 86_400_000);
  const [focusing, recent] =
    accepted.length === 0
      ? [[], []]
      : await Promise.all([
          deps.db
            .select({ userId: focusSessions.userId })
            .from(focusSessions)
            .where(
              and(inArray(focusSessions.userId, accepted), eq(focusSessions.status, 'in_progress')),
            ),
          // Completed starts for the streak (A3's rule), and the last 7 days' focus.
          deps.db
            .select({
              userId: focusSessions.userId,
              startedAt: focusSessions.startedAt,
              status: focusSessions.status,
              focusedSeconds: focusSessions.focusedSeconds,
            })
            .from(focusSessions)
            .where(
              and(
                inArray(focusSessions.userId, accepted),
                ne(focusSessions.status, 'in_progress'),
                isNotNull(focusSessions.endedAt),
                sql`${focusSessions.startedAt} >= ${new Date(nowMs - 400 * 86_400_000)}`,
              ),
            ),
        ]);
  const localDate = (ms: number) => createLocalMomentFormatter(tz)(ms).date;
  const today = localDate(nowMs);

  return buddiesResponseSchema.parse({
    code,
    buddies: accepted.flatMap((id) => {
      const person = profile(id);
      if (person === undefined) {
        return [];
      }
      const theirs = recent.filter((row) => row.userId === id);
      const days = new Set(
        theirs
          .filter((row) => row.status === 'completed')
          .map((row) => localDate(row.startedAt.getTime())),
      );
      return [
        {
          userId: id,
          displayName: person.displayName,
          avatarPreset: person.avatarPreset,
          focusingNow: focusing.some((row) => row.userId === id),
          currentStreak: computeStreak(days, today).current,
          weekFocusedSeconds: theirs
            .filter((row) => row.startedAt >= weekAgo)
            .reduce((sum, row) => sum + row.focusedSeconds, 0),
        },
      ];
    }),
    incoming: links
      .filter((link) => link.acceptedAt === null && link.addresseeId === userId)
      .flatMap((link) => {
        const person = profile(link.requesterId);
        return person === undefined
          ? []
          : [
              {
                userId: link.requesterId,
                displayName: person.displayName,
                avatarPreset: person.avatarPreset,
                requestedAt: link.createdAt.toISOString(),
              },
            ];
      }),
    outgoing: links
      .filter((link) => link.acceptedAt === null && link.requesterId === userId)
      .flatMap((link) => {
        const person = profile(link.addresseeId);
        return person === undefined
          ? []
          : [
              {
                userId: link.addresseeId,
                displayName: person.displayName,
                avatarPreset: person.avatarPreset,
                requestedAt: link.createdAt.toISOString(),
              },
            ];
      }),
  });
};

/**
 * BD3: asks the owner of `code` to be buddies. Your own or an unknown code is 404
 * BUDDY_CODE_UNKNOWN (nothing reveals which). If they had already asked you, you become
 * buddies at once; asking again is harmless. At most BUDDIES_MAX links (409 BUDDIES_FULL).
 */
export const requestBuddy = async (
  deps: BuddiesDeps,
  userId: string,
  code: string,
): Promise<'requested' | 'buddies'> => {
  const [target] = await deps.db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.buddyCode, code))
    .limit(1);
  if (target === undefined || target.id === userId) {
    throw new AppError('BUDDY_CODE_UNKNOWN', 404, 'No one has that buddy code.');
  }
  return deps.db.transaction(async (tx) => {
    await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for('update');
    const [existing] = await tx.select().from(buddyLinks).where(pairWith(userId, target.id));
    if (existing !== undefined) {
      if (existing.acceptedAt !== null) {
        return 'buddies';
      }
      if (existing.addresseeId === userId) {
        await tx
          .update(buddyLinks)
          .set({ acceptedAt: sql`now()` })
          .where(eq(buddyLinks.id, existing.id));
        return 'buddies';
      }
      return 'requested';
    }
    const [held] = await tx.select({ total: count() }).from(buddyLinks).where(linksOf(userId));
    if ((held?.total ?? 0) >= BUDDIES_MAX) {
      throw new AppError('BUDDIES_FULL', 409, 'You have many buddies and requests already.');
    }
    try {
      await tx
        .insert(buddyLinks)
        .values({ id: uuidv7(), requesterId: userId, addresseeId: target.id });
    } catch (error) {
      if (isUniqueViolation(error)) {
        return 'requested';
      }
      throw error;
    }
    return 'requested';
  });
};

/** BD3: accepts a request they sent you; anything else is 404 NOT_BUDDIES. */
export const acceptBuddy = async (
  deps: BuddiesDeps,
  userId: string,
  otherId: string,
): Promise<void> => {
  const updated = await deps.db
    .update(buddyLinks)
    .set({ acceptedAt: sql`coalesce(${buddyLinks.acceptedAt}, now())` })
    .where(and(eq(buddyLinks.requesterId, otherId), eq(buddyLinks.addresseeId, userId)))
    .returning({ id: buddyLinks.id });
  if (updated.length === 0) {
    throw new AppError('NOT_BUDDIES', 404, 'No request from that person.');
  }
};

/** BD3: ends the link whatever its state: unfriend, decline or cancel. Idempotent (204). */
export const removeBuddy = async (
  deps: BuddiesDeps,
  userId: string,
  otherId: string,
): Promise<void> => {
  await deps.db.delete(buddyLinks).where(pairWith(userId, otherId));
};

/** BD4: a gentle nudge to an accepted buddy, at most once an hour per pair (429). */
export const nudgeBuddy = async (
  deps: BuddiesDeps,
  userId: string,
  otherId: string,
): Promise<void> => {
  const [link] = await deps.db
    .select({ acceptedAt: buddyLinks.acceptedAt })
    .from(buddyLinks)
    .where(pairWith(userId, otherId));
  if (link?.acceptedAt === null || link === undefined) {
    throw new AppError('NOT_BUDDIES', 404, 'You are not buddies.');
  }
  if (!(await deps.allowNudge(userId, otherId))) {
    throw new AppError('RATE_LIMITED', 429, 'You nudged them recently. Give it an hour.');
  }
  const [me] = await deps.db
    .select({ displayName: users.displayName })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  deps.notify(otherId, {
    fromUserId: userId as BuddyNudgeEvent['fromUserId'],
    displayName: me?.displayName ?? 'A buddy',
  });
};
