import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
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

// Phase 4B: solo focus sessions (docs/domain/model.md, decisions D6, D14/15/35, E1–E16).
// Solo only: room sessions add `room_id`, `focus_run_id` and the room-only abandon reasons
// in Phase 6 (E4, E5). The lifecycle rules that need the clock or presence (completion,
// grace, expiry) live in modules/focus-sessions; the table guarantees the invariants that
// must hold whatever code writes it.
export const focusSessions = pgTable(
  'focus_sessions',
  {
    id: uuid().notNull(),
    userId: uuid().notNull(),
    // D4: optional. Starting with a deleted or completed task is rejected by the service
    // (E3); a task deleted later stays linked for history (D38).
    taskId: uuid(),
    status: text().notNull(),
    abandonReason: text(),
    plannedSeconds: integer().notNull(),
    // D6: time accumulated before the current running stretch, whole seconds (E14).
    focusedSeconds: integer().notNull().default(0),
    // D6: start of the current running stretch; NULL while paused or ended.
    runningSince: timestamp({ withTimezone: true }),
    startedAt: timestamp({ withTimezone: true }).notNull(),
    endedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    primaryKey({ name: 'pk_focus_sessions', columns: [table.id] }),
    foreignKey({
      name: 'fk_focus_sessions_user_id',
      columns: [table.userId],
      foreignColumns: [users.id],
    }).onDelete('cascade'),
    // Composite FK: the task must be one of this user's own tasks. No ON DELETE action
    // (P1): tasks are soft-deleted, so a task row only disappears together with its user,
    // whose sessions cascade away in the same statement.
    foreignKey({
      name: 'fk_focus_sessions_task_id',
      columns: [table.taskId, table.userId],
      foreignColumns: [tasks.id, tasks.userId],
    }),
    check(
      'ck_focus_sessions_status',
      sql`${table.status} IN ('in_progress', 'completed', 'abandoned')`,
    ),
    // E5: solo reasons only until Phase 6.
    check(
      'ck_focus_sessions_abandon_reason',
      sql`${table.abandonReason} IN ('stopped', 'grace_expired', 'expired')`,
    ),
    // E1.
    check('ck_focus_sessions_planned_seconds', sql`${table.plannedSeconds} BETWEEN 60 AND 14400`),
    check(
      'ck_focus_sessions_focused_seconds',
      sql`${table.focusedSeconds} BETWEEN 0 AND ${table.plannedSeconds}`,
    ),
    check(
      'ck_focus_sessions_ended_at',
      sql`(${table.status} = 'in_progress') = (${table.endedAt} IS NULL)`,
    ),
    check(
      'ck_focus_sessions_abandon_reason_presence',
      sql`(${table.status} = 'abandoned') = (${table.abandonReason} IS NOT NULL)`,
    ),
    check(
      'ck_focus_sessions_running_since',
      sql`${table.runningSince} IS NULL OR ${table.status} = 'in_progress'`,
    ),
    check(
      'ck_focus_sessions_ended_after_started',
      sql`${table.endedAt} IS NULL OR ${table.endedAt} >= ${table.startedAt}`,
    ),
    // E15.
    check(
      'ck_focus_sessions_running_since_after_started',
      sql`${table.runningSince} IS NULL OR ${table.runningSince} >= ${table.startedAt}`,
    ),
    check(
      'ck_focus_sessions_completed_focused',
      sql`${table.status} <> 'completed' OR ${table.focusedSeconds} = ${table.plannedSeconds}`,
    ),
    // At most one in-progress session per user. It also serves every scan of in-progress
    // sessions (the reconciler sweep, stale cleanup), since it holds only those rows.
    uniqueIndex('uq_focus_sessions_user_id_in_progress')
      .on(table.userId)
      .where(sql`${table.status} = 'in_progress'`),
    // History, newest first (Phase 5), and the ON DELETE CASCADE from users.
    index('ix_focus_sessions_user_id_started_at').on(table.userId, table.startedAt.desc()),
  ],
);
