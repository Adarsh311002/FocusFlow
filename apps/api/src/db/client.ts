import { drizzle } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';

import * as schema from './schema.js';

export const createDb = (pool: Pool) => drizzle(pool, { schema, casing: 'snake_case' });

export type Db = ReturnType<typeof createDb>;

/**
 * The type `db.transaction(async (tx) => ...)` passes to its callback. Derived from
 * `Db` itself (rather than importing a driver-specific transaction class) so it can
 * never drift from whatever `createDb` actually returns.
 */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** Accepted by any query function that must also be usable inside a transaction. */
export type Executor = Db | Tx;
