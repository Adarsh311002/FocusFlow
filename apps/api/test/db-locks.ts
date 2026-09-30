import type { Pool, PoolClient } from 'pg';

/**
 * Deterministic concurrency testing: a transaction held open on its own connection, so a
 * test can take a row lock, issue a competing request, prove that request is blocked by
 * exactly this transaction, and only then commit.
 */
export type HeldTransaction = {
  readonly client: PoolClient;
  /** Backend process id of the holder, as `pg_blocking_pids` reports it. */
  readonly pid: number;
  readonly commit: () => Promise<void>;
  readonly rollback: () => Promise<void>;
};

export const beginHeldTransaction = async (pool: Pool): Promise<HeldTransaction> => {
  const client = await pool.connect();
  const { rows } = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
  const pid = rows[0]?.pid;
  if (pid === undefined) {
    client.release();
    throw new Error('could not read the backend pid');
  }
  await client.query('BEGIN');

  let finished = false;
  const finish = async (statement: 'COMMIT' | 'ROLLBACK'): Promise<void> => {
    if (finished) {
      return;
    }
    finished = true;
    try {
      await client.query(statement);
    } finally {
      client.release();
    }
  };

  return {
    client,
    pid,
    commit: () => finish('COMMIT'),
    rollback: () => finish('ROLLBACK'),
  };
};

/**
 * Resolves once at least one other backend is waiting on a lock held by `holderPid`
 * (PostgreSQL's own view of who blocks whom). Rejects if that does not happen in time.
 */
export const waitUntilBlockedBy = async (
  pool: Pool,
  holderPid: number,
  timeoutMs = 10_000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { rows } = await pool.query<{ blocked: number }>(
      'SELECT count(*)::int AS blocked FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))',
      [holderPid],
    );
    if ((rows[0]?.blocked ?? 0) > 0) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `no backend became blocked by pid ${String(holderPid)} within ${String(timeoutMs)} ms`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

/** Observes whether a promise has settled without awaiting it. */
export const trackSettled = <T>(promise: Promise<T>) => {
  const state = { settled: false };
  const done = promise.finally(() => {
    state.settled = true;
  });
  return { state, done };
};
