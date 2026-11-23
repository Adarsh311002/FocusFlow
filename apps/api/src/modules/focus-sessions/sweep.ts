import type { Logger } from 'pino';

import {
  expireStaleSession,
  FollowUpError,
  type LifecycleDeps,
  type ReconcileOutcome,
  reconcileRunningSession,
  type StaleOutcome,
} from './lifecycle.js';
import { databaseNowMs, listInProgressSessionKeys, type SessionKey } from './queries.js';

// The reconciler's Solo Focus steps (docs/architecture/focus-timing-protocol.md,
// "Reconciler"; E2, E17–E20, E22):
//   5. every running session: the decision for a running session, settled directly when
//      terminal; otherwise its jobs ensured, or late grace started;
//   6. every session still in progress 12 hours after `started_at`: abandoned(expired).
// Both scan in-progress sessions in keyset batches (no lock), then lock each session with
// `FOR UPDATE SKIP LOCKED` in its own transaction, so concurrent runs on several instances
// never wait for each other or decide one session twice. One session's failure is logged
// and counted; the sweep goes on.

/** E2: a solo session still in progress this long after `started_at` is stale. */
export const SOLO_STALE_AFTER_MS = 12 * 60 * 60 * 1_000;
export const SWEEP_BATCH_SIZE = 100;
/** Sessions decided at once: the pool (10 connections) is shared with the API. */
export const SWEEP_CONCURRENCY = 4;
/** Bounds each statement of a sweep transaction (`SET LOCAL statement_timeout`). */
export const SWEEP_STATEMENT_TIMEOUT_MS = 5_000;

export type SweepOptions = {
  readonly batchSize?: number;
  readonly concurrency?: number;
  readonly statementTimeoutMs?: number;
  readonly staleAfterMs?: number;
  /** Checked before each batch and each session: false stops the sweep (deadline, shutdown). */
  readonly shouldContinue?: () => boolean;
  /** Tests only: runs after each batch (for example to lose Redis data between batches). */
  readonly afterBatch?: (batchIndex: number) => Promise<void>;
};

export type SweepSummary = {
  /** Sessions per outcome, for example `settled:completed`, `deferred`, `skipped_locked`. */
  readonly outcomes: Readonly<Record<string, number>>;
  /** Sessions whose transaction failed (nothing committed). */
  readonly failed: number;
  /** Sessions whose transition committed but whose follow-up failed (counted in outcomes). */
  readonly followUpFailed: number;
  /** False when `shouldContinue` stopped the sweep before it reached the end. */
  readonly complete: boolean;
};

const outcomeLabel = (outcome: ReconcileOutcome | StaleOutcome): string => {
  switch (outcome.kind) {
    case 'settled':
      return `settled:${outcome.transition}`;
    case 'no_op':
      return `no_op:${outcome.reason}`;
    case 'deferred':
      return `deferred:${outcome.reason}`;
    default:
      return outcome.kind;
  }
};

/** Runs `task` over `items` with at most `concurrency` in flight. */
const forEachBounded = async <T>(
  items: readonly T[],
  concurrency: number,
  task: (item: T) => Promise<void>,
): Promise<void> => {
  let next = 0;
  const lanes = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (let index = next++; index < items.length; index = next++) {
      const item = items[index];
      if (item !== undefined) {
        await task(item);
      }
    }
  });
  await Promise.all(lanes);
};

const sweep = async (
  deps: { readonly db: LifecycleDeps['db']; readonly logger: Logger },
  options: SweepOptions,
  page: { readonly running?: boolean; readonly startedBeforeMs?: number },
  decide: (key: SessionKey) => Promise<ReconcileOutcome | StaleOutcome>,
): Promise<SweepSummary> => {
  const batchSize = options.batchSize ?? SWEEP_BATCH_SIZE;
  const shouldContinue = options.shouldContinue ?? (() => true);
  const outcomes: Record<string, number> = {};
  const count = (label: string) => {
    outcomes[label] = (outcomes[label] ?? 0) + 1;
  };
  let failed = 0;
  let followUpFailed = 0;
  let complete = true;
  let afterUserId: string | null = null;

  for (let batchIndex = 0; ; batchIndex += 1) {
    if (!shouldContinue()) {
      complete = false;
      break;
    }
    const keys = await listInProgressSessionKeys(deps.db, {
      ...page,
      afterUserId,
      limit: batchSize,
    });
    await forEachBounded(keys, options.concurrency ?? SWEEP_CONCURRENCY, async (key) => {
      if (!shouldContinue()) {
        complete = false;
        return;
      }
      try {
        count(outcomeLabel(await decide(key)));
      } catch (error) {
        if (error instanceof FollowUpError) {
          count(outcomeLabel(error.outcome));
          followUpFailed += 1;
          deps.logger.warn(
            { err: error.cause, sessionId: key.id, outcome: error.outcome },
            'Focus session committed, but its follow-up failed; the next reconcile repairs it',
          );
        } else {
          failed += 1;
          deps.logger.warn(
            { err: error, sessionId: key.id },
            'Could not reconcile a focus session',
          );
        }
      }
    });
    await options.afterBatch?.(batchIndex);
    const last = keys.at(-1);
    if (last === undefined || keys.length < batchSize) {
      break;
    }
    afterUserId = last.userId;
  }
  return { outcomes, failed, followUpFailed, complete };
};

/** Reconciler step 5: the decision for every running session. */
export const sweepRunningSessions = (
  deps: LifecycleDeps & { readonly logger: Logger },
  options: SweepOptions = {},
): Promise<SweepSummary> =>
  sweep(deps, options, { running: true }, (key) =>
    reconcileRunningSession(deps, key, options.statementTimeoutMs ?? SWEEP_STATEMENT_TIMEOUT_MS),
  );

/**
 * Reconciler step 6: every session in progress at least `staleAfterMs` after `started_at`
 * (by the PostgreSQL clock; each is re-checked under its lock). PostgreSQL only (E22).
 */
export const sweepStaleSessions = async (
  deps: Pick<LifecycleDeps, 'db' | 'changes'> & { readonly logger: Logger },
  options: SweepOptions = {},
): Promise<SweepSummary> => {
  const staleAfterMs = options.staleAfterMs ?? SOLO_STALE_AFTER_MS;
  const startedBeforeMs = (await databaseNowMs(deps.db)) - staleAfterMs;
  return sweep(deps, options, { startedBeforeMs }, (key) =>
    expireStaleSession(deps, key, {
      staleAfterMs,
      statementTimeoutMs: options.statementTimeoutMs ?? SWEEP_STATEMENT_TIMEOUT_MS,
    }),
  );
};
