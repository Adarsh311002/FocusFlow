import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  pgTable,
  type PgTableExtraConfigValue,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

// docs/domain/model.md: PostgreSQL 18, UUIDv7 generated in the application, timestamptz
// in UTC, snake_case columns (via drizzle.config.ts `casing: 'snake_case'`), explicit
// constraint/index names. `auth_identities` is created now (unused until Phase 1b, per
// D1/D44) so its shape is fixed alongside the rest of the account schema.

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
    // D3: the current focus task belongs to the user, not to the task. Always NULL or an
    // open, non-deleted task of this same user; the "open, non-deleted" half is enforced
    // by modules/tasks/service.ts (docs/domain/model.md, "Rules the database cannot
    // enforce alone").
    currentTaskId: uuid(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  // The explicit return type breaks the users <-> tasks reference cycle for type inference.
  (table): PgTableExtraConfigValue[] => [
    primaryKey({ name: 'pk_users', columns: [table.id] }),
    // Composite FK: the current task must be one of this user's own tasks. No ON DELETE
    // action (P1): tasks are soft-deleted, so a task row is only ever removed together
    // with its user (the tasks.user_id cascade).
    foreignKey({
      name: 'fk_users_current_task_id',
      columns: [table.currentTaskId, table.id],
      foreignColumns: [tasks.id, tasks.userId],
    }),
    // Case-insensitivity is enforced by normalizing email to lowercase before every
    // write (docs/architecture/auth.md); the CHECK makes that invariant a database
    // guarantee too, so a future write path can't silently bypass the normalization
    // in application code and create two rows for the same address.
    uniqueIndex('uq_users_email').on(table.email),
    check('ck_users_email_lowercase', sql`${table.email} = lower(${table.email})`),
    check('ck_users_display_name_length', sql`char_length(${table.displayName}) BETWEEN 1 AND 50`),
  ],
);

export const tasks = pgTable(
  'tasks',
  {
    id: uuid().notNull(),
    userId: uuid().notNull(),
    title: text().notNull(),
    // NULL = open.
    completedAt: timestamp({ withTimezone: true }),
    // D38: soft delete. A deleted task is hidden from every normal read but its row stays,
    // so history that references it keeps its meaning.
    deletedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    primaryKey({ name: 'pk_tasks', columns: [table.id] }),
    foreignKey({
      name: 'fk_tasks_user_id',
      columns: [table.userId],
      foreignColumns: [users.id],
    }).onDelete('cascade'),
    // Target of the composite FKs that pin a task reference to the same user
    // (users.current_task_id now; focus_sessions.task_id in Phase 4).
    unique('uq_tasks_id_user_id').on(table.id, table.userId),
    check('ck_tasks_title_length', sql`char_length(${table.title}) BETWEEN 1 AND 200`),
    // One full (not partial) index serves both keyset pagination (newest-created first:
    // UUIDv7 ids sort by creation time) and the ON DELETE CASCADE from users, which must
    // also reach soft-deleted rows.
    index('ix_tasks_user_id_id').on(table.userId, table.id.desc()),
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
