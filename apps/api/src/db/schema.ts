import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

// docs/domain/model.md: PostgreSQL 18, UUIDv7 generated in the application, timestamptz
// in UTC, snake_case columns (via drizzle.config.ts `casing: 'snake_case'`), explicit
// constraint/index names. `tasks`/`current_task_id` arrive in Phase 2; `auth_identities`
// is created now (unused until Phase 1b, per D1/D44) so its shape is fixed alongside the
// rest of the account schema.

export const users = pgTable(
  'users',
  {
    id: uuid().notNull(),
    email: text().notNull(),
    // D1: set at signup for Google-created accounts; NULL for password signups until
    // Phase 1b's verification/reset flows exist (D39).
    emailVerifiedAt: timestamp({ withTimezone: true }),
    displayName: text().notNull(),
    // NULL for a user who only ever signs in with a linked identity (Phase 1b).
    passwordHash: text(),
    avatarUrl: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    primaryKey({ name: 'pk_users', columns: [table.id] }),
    // Case-insensitivity is enforced by normalizing email to lowercase before every
    // write (docs/architecture/auth.md); the CHECK makes that invariant a database
    // guarantee too, so a future write path can't silently bypass the normalization
    // in application code and create two rows for the same address.
    uniqueIndex('uq_users_email').on(table.email),
    check('ck_users_email_lowercase', sql`${table.email} = lower(${table.email})`),
    check('ck_users_display_name_length', sql`char_length(${table.displayName}) BETWEEN 1 AND 50`),
  ],
);

export const authIdentities = pgTable(
  'auth_identities',
  {
    id: uuid().notNull(),
    userId: uuid().notNull(),
    provider: text().notNull(),
    providerSubject: text().notNull(),
    emailAtLink: text().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ name: 'pk_auth_identities', columns: [table.id] }),
    foreignKey({
      name: 'fk_auth_identities_user_id',
      columns: [table.userId],
      foreignColumns: [users.id],
    }).onDelete('cascade'),
    uniqueIndex('uq_auth_identities_provider_subject').on(table.provider, table.providerSubject),
    check('ck_auth_identities_provider', sql`${table.provider} IN ('google')`),
    // Every lookup and the ON DELETE CASCADE both go through this column.
    index('ix_auth_identities_user_id').on(table.userId),
  ],
);

export const authSessions = pgTable(
  'auth_sessions',
  {
    // Also the "sid" claim in the access token and the first segment of the refresh
    // token (docs/architecture/auth.md).
    id: uuid().notNull(),
    userId: uuid().notNull(),
    currentTokenHash: text().notNull(),
    previousTokenHash: text(),
    previousValidUntil: timestamp({ withTimezone: true }),
    rotatedAt: timestamp({ withTimezone: true }),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    revokedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ name: 'pk_auth_sessions', columns: [table.id] }),
    foreignKey({
      name: 'fk_auth_sessions_user_id',
      columns: [table.userId],
      foreignColumns: [users.id],
    }).onDelete('cascade'),
    index('ix_auth_sessions_user_id').on(table.userId),
  ],
);
