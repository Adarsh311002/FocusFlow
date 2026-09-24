import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';

// A standalone CLI step (`pnpm db:migrate`), never run by the API process at startup
// (docs/implementation/plan.md, I6). Reads its own connection string rather than going
// through platform/config.ts, which also requires REDIS_URL and other variables this
// script has no use for.
const connectionString = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;

if (connectionString === undefined || connectionString.length === 0) {
  process.stderr.write('Cannot run migrations: set MIGRATION_DATABASE_URL or DATABASE_URL.\n');
  process.exit(1);
}

const pool = new pg.Pool({ connectionString });
const db = drizzle(pool);

try {
  await migrate(db, { migrationsFolder: './src/db/migrations' });
  process.stdout.write('Migrations applied.\n');
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Migration failed.\n${message}\n`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
