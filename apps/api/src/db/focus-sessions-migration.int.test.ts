import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Migration 0004_add_room_focus_sessions (RF1) applied to a database that is already at
// 0003 and holds solo sessions: the new columns are nullable, so old rows survive with NULL
// in both, and the widened constraints still accept them.

const MIGRATIONS = fileURLToPath(new URL('./migrations', import.meta.url));

const USER_ID = '01900000-0000-7000-8000-000000000001';
const RUNNING_ID = '01900000-0000-7000-8000-0000000000a1';
const STOPPED_ID = '01900000-0000-7000-8000-0000000000a2';
const ROOM_SESSION_ID = '01900000-0000-7000-8000-0000000000a3';
const ROOM_ID = '01900000-0000-7000-8000-0000000000b1';
const RUN_ID = '01900000-0000-7000-8000-0000000000c1';

let container: StartedPostgreSqlContainer | undefined;
let pool: pg.Pool | undefined;
let scratch: string | undefined;

const client = (): pg.Pool => {
  if (pool === undefined) {
    throw new Error('the database failed to start');
  }
  return pool;
};

/** A copy of the migrations folder whose journal stops at 0003 (the pre-Phase-8 database). */
const copyUpTo0003 = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'ff-migrations-'));
  scratch = dir;
  await cp(MIGRATIONS, dir, { recursive: true });
  const journalPath = join(dir, 'meta', '_journal.json');
  const journal = JSON.parse(await readFile(journalPath, 'utf8')) as {
    entries: { tag: string }[];
  };
  journal.entries = journal.entries.filter((entry) => !entry.tag.startsWith('0004_'));
  await writeFile(journalPath, JSON.stringify(journal));
  return dir;
};

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:18').start();
  pool = new pg.Pool({ connectionString: container.getConnectionUri() });
}, 120_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
  if (scratch !== undefined) {
    await rm(scratch, { recursive: true, force: true });
  }
}, 60_000);

describe('migration 0004 on a database at 0003', () => {
  it('keeps existing solo sessions, backfilling NULL, and enables room sessions', async () => {
    await migrate(drizzle(client()), { migrationsFolder: await copyUpTo0003() });

    const before = await client().query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'focus_sessions' AND column_name IN ('room_id', 'focus_run_id')`,
    );
    expect(before.rowCount).toBe(0);

    await client().query(
      `INSERT INTO users (id, email, display_name, password_hash)
       VALUES ('${USER_ID}', 'old@example.com', 'Old', 'x')`,
    );
    await client().query(
      `INSERT INTO focus_sessions (id, user_id, status, planned_seconds, running_since, started_at)
       VALUES ('${RUNNING_ID}', '${USER_ID}', 'in_progress', 1500, now(), now())`,
    );
    await client().query(
      `INSERT INTO focus_sessions (id, user_id, status, abandon_reason, planned_seconds,
                                   focused_seconds, started_at, ended_at)
       VALUES ('${STOPPED_ID}', '${USER_ID}', 'abandoned', 'stopped', 1500, 300,
               now() - interval '1 hour', now())`,
    );

    await migrate(drizzle(client()), { migrationsFolder: MIGRATIONS });

    const rows = await client().query<{ room_id: string | null; focus_run_id: string | null }>(
      `SELECT room_id, focus_run_id FROM focus_sessions ORDER BY id`,
    );
    expect(rows.rows).toEqual([
      { room_id: null, focus_run_id: null },
      { room_id: null, focus_run_id: null },
    ]);

    // The old solo row still follows every rule, and a room session with a new reason works.
    await client().query(
      `UPDATE focus_sessions SET status = 'abandoned', abandon_reason = 'expired',
              running_since = NULL, ended_at = now() + interval '1 second'
       WHERE id = '${RUNNING_ID}'`,
    );
    await client().query(
      `INSERT INTO rooms (id, code, name, host_id, is_private)
       VALUES ('${ROOM_ID}', 'TESTAA', 'Room', '${USER_ID}', false)`,
    );
    await client().query(
      `INSERT INTO focus_sessions (id, user_id, room_id, focus_run_id, status, abandon_reason,
                                   planned_seconds, started_at, ended_at)
       VALUES ('${ROOM_SESSION_ID}', '${USER_ID}', '${ROOM_ID}', '${RUN_ID}', 'abandoned',
               'timer_lost', 1500, now(), now() + interval '1 second')`,
    );
  }, 120_000);
});
