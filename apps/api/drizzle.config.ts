import { defineConfig } from 'drizzle-kit';

// Used only by `drizzle-kit generate`, which diffs `src/db/schema.ts` against the
// migration snapshots in `src/db/migrations/meta` — no database connection needed.
// Applying the generated SQL is a separate step (`db:migrate`, src/db/migrate.ts).
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './src/db/migrations',
  casing: 'snake_case',
});
