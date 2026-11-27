import {
  API_BASE_PATH,
  errorBodySchema,
  forestPaths,
  forestResponseSchema,
} from '@focus-flow/contracts';
import { uuidv7 } from 'uuidv7';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startTestHarness, stopTestHarness, type TestHarness } from '../../../test/harness.js';
import { signUpTestUser, type TestUser } from '../../../test/users.js';
import { focusSessions } from '../../db/schema.js';

// GET /forest (GF5) against the real API and PostgreSQL.

let harness: TestHarness | undefined;

const requireHarness = (): TestHarness => {
  if (harness === undefined) {
    throw new Error('the API harness failed to start');
  }
  return harness;
};

const get = async (user: TestUser | null, query: string) => {
  const response = await fetch(
    `${requireHarness().baseUrl}${API_BASE_PATH}${forestPaths.self}${query}`,
    user === null ? {} : { headers: { Authorization: `Bearer ${user.accessToken}` } },
  );
  return { status: response.status, body: await response.json() };
};

/** An ended session written directly, as the lifecycle would have left it. */
const seed = async (
  user: TestUser,
  values: { startedAt: string; status: 'completed' | 'abandoned'; outcome?: 'done' },
) => {
  const startedAt = new Date(values.startedAt);
  await requireHarness()
    .db.insert(focusSessions)
    .values({
      id: uuidv7(),
      userId: user.userId,
      status: values.status,
      abandonReason: values.status === 'abandoned' ? 'stopped' : null,
      plannedSeconds: 1_500,
      focusedSeconds: values.status === 'completed' ? 1_500 : 120,
      startedAt,
      endedAt: new Date(startedAt.getTime() + 1_500_000),
      checkInOutcome: values.outcome ?? null,
      checkedInAt: values.outcome === undefined ? null : new Date(startedAt.getTime() + 1_600_000),
    });
};

beforeAll(async () => {
  harness = await startTestHarness();
}, 180_000);

afterAll(async () => {
  if (harness !== undefined) {
    await stopTestHarness(harness);
  }
}, 60_000);

describe('GET /forest', () => {
  it('grows the caller’s own forest from their ended sessions', async () => {
    const h = requireHarness();
    const user = await signUpTestUser(h, 'grower');
    const other = await signUpTestUser(h, 'neighbour');
    await seed(user, { startedAt: '2026-11-20T08:00:00Z', status: 'completed', outcome: 'done' });
    await seed(user, { startedAt: '2026-11-21T08:00:00Z', status: 'completed' });
    // Two minutes of focus before stopping grows nothing (GF2).
    await seed(user, { startedAt: '2026-11-22T08:00:00Z', status: 'abandoned' });

    const result = await get(user, '?tz=Asia%2FKolkata');
    expect(result.status).toBe(200);
    const forest = forestResponseSchema.parse(result.body);
    expect(forest.totals).toMatchObject({
      plants: 2,
      completedSessions: 2,
      intentionsDone: 1,
      focusedSeconds: 3_120,
    });
    expect(forest.plants.map((plant) => [plant.kind, plant.bloom])).toEqual([
      ['sapling', true],
      ['sapling', false],
    ]);
    expect(forest.milestones.find((m) => m.id === 'first-seed')?.unlockedAt).not.toBeNull();

    const empty = forestResponseSchema.parse((await get(other, '?tz=UTC')).body);
    expect(empty.totals.plants).toBe(0);
  });

  it('needs a token and a valid time zone', async () => {
    const user = await signUpTestUser(requireHarness(), 'zoneless');
    expect((await get(null, '?tz=UTC')).status).toBe(401);
    for (const query of ['', '?tz=Mars%2FOlympus', '?tz=UTC&extra=1']) {
      const result = await get(user, query);
      expect(result.status).toBe(400);
      expect(errorBodySchema.parse(result.body).error.code).toBe('VALIDATION_FAILED');
    }
  });
});
