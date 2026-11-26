import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  pgTable,
  type PgTableExtraConfigValue,
  primaryKey,
  smallint,
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
    // A1: the user's daily focus goal in whole seconds (dashboard progress, streak views).
    dailyGoalSeconds: integer().notNull().default(7200),
    // ST2: a forest-animal avatar chosen in settings (NULL: the initial).
    avatarPreset: text(),
    // ST3: the session length the start form opens with.
    defaultSessionSeconds: integer().notNull().default(1500),
    // BD1: the personal code others enter to ask to be focus buddies; made on first use.
    buddyCode: text(),
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
    check('ck_users_daily_goal_seconds', sql`${table.dailyGoalSeconds} BETWEEN 300 AND 43200`),
    uniqueIndex('uq_users_buddy_code').on(table.buddyCode),
    check(
      'ck_users_avatar_preset',
      sql`${table.avatarPreset} IN ('monkey', 'sloth', 'toucan', 'frog', 'owl', 'butterfly', 'jaguar')`,
    ),
    check(
      'ck_users_default_session_seconds',
      sql`${table.defaultSessionSeconds} BETWEEN 60 AND 14400`,
    ),
  ],
);

// Goals (GL1): what a set of tasks is for ("Ship the beta", "Learn Spanish"). Never deleted;
// a goal is completed or archived. Deleting the user removes their goals (cascade).
export const goals = pgTable(
  'goals',
  {
    id: uuid().notNull(),
    userId: uuid().notNull(),
    title: text().notNull(),
    why: text(),
    targetDate: date({ mode: 'string' }),
    color: text().notNull().default('leaf'),
    completedAt: timestamp({ withTimezone: true }),
    archivedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    primaryKey({ name: 'pk_goals', columns: [table.id] }),
    foreignKey({
      name: 'fk_goals_user_id',
      columns: [table.userId],
      foreignColumns: [users.id],
    }).onDelete('cascade'),
    // Target of tasks.goal_id's composite key: a task's goal is the same user's.
    unique('uq_goals_id_user_id').on(table.id, table.userId),
    check('ck_goals_title_length', sql`char_length(${table.title}) BETWEEN 1 AND 80`),
    check(
      'ck_goals_why_length',
      sql`${table.why} IS NULL OR char_length(${table.why}) BETWEEN 1 AND 280`,
    ),
    check(
      'ck_goals_color',
      sql`${table.color} IN ('leaf', 'moss', 'fern', 'amber', 'berry', 'sky')`,
    ),
    // A goal is active, completed or archived, never completed and archived at once.
    check('ck_goals_one_end', sql`${table.completedAt} IS NULL OR ${table.archivedAt} IS NULL`),
    index('ix_goals_user_id_id').on(table.userId, table.id.desc()),
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
    // GL2: the goal it serves, the same user's (composite key); no ON DELETE action (P1).
    goalId: uuid(),
    // ES1: "I think this takes N sessions".
    estimatedSessions: smallint(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    primaryKey({ name: 'pk_tasks', columns: [table.id] }),
    foreignKey({
      name: 'fk_tasks_goal_id',
      columns: [table.goalId, table.userId],
      foreignColumns: [goals.id, goals.userId],
    }),
    check(
      'ck_tasks_estimated_sessions',
      sql`${table.estimatedSessions} IS NULL OR ${table.estimatedSessions} BETWEEN 1 AND 20`,
    ),
    // A goal's tasks.
    index('ix_tasks_goal_id').on(table.goalId),
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
// Solo sessions have `room_id`/`focus_run_id` NULL; Phase 8 room sessions (RF1) set both
// and add the room-only abandon reasons. The lifecycle rules that need the clock or presence (completion,
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
    // RF1: set together for a room focus session, NULL for a solo one. The run itself lives
    // in Redis, so `focus_run_id` has no foreign key.
    roomId: uuid(),
    focusRunId: uuid(),
    plannedSeconds: integer().notNull(),
    // D6: time accumulated before the current running stretch, whole seconds (E14).
    focusedSeconds: integer().notNull().default(0),
    // D6: start of the current running stretch; NULL while paused or ended.
    runningSince: timestamp({ withTimezone: true }),
    startedAt: timestamp({ withTimezone: true }).notNull(),
    endedAt: timestamp({ withTimezone: true }),
    // CI1: the user's own account of an ended session ("did you finish it?"), all three set
    // together; the note is optional. Never part of the focus-time arithmetic.
    checkInOutcome: text(),
    checkInNote: text(),
    checkedInAt: timestamp({ withTimezone: true }),
    // FQ1: "how deep was it?", 1–5, optional part of the check-in.
    checkInQuality: smallint(),
    // RI1: the participant chose to show their task's title to the room. Room sessions with
    // a task only; the title itself is read from `tasks` when the list is built (RF14).
    shareIntention: boolean().notNull().default(false),
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
    // RF1: no ON DELETE action (P1); rooms are never deleted in the MVP.
    foreignKey({
      name: 'fk_focus_sessions_room_id',
      columns: [table.roomId],
      foreignColumns: [rooms.id],
    }),
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
    // E5 (solo) plus the room reasons of RF1.
    check(
      'ck_focus_sessions_abandon_reason',
      sql`${table.abandonReason} IN ('stopped', 'grace_expired', 'expired', 'opted_out', 'left_room', 'removed', 'reset', 'phase_changed', 'timer_lost')`,
    ),
    // RF1: a room session has both the room and the run, a solo one has neither.
    check(
      'ck_focus_sessions_room_run',
      sql`(${table.roomId} IS NULL) = (${table.focusRunId} IS NULL)`,
    ),
    // RF1: the room timer owns the clock of a room session, so `running_since` is solo-only.
    check(
      'ck_focus_sessions_running_since_solo',
      sql`${table.roomId} IS NULL OR ${table.runningSince} IS NULL`,
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
    // CI1.
    check(
      'ck_focus_sessions_check_in_outcome',
      sql`${table.checkInOutcome} IN ('done', 'progress', 'stuck')`,
    ),
    check(
      'ck_focus_sessions_check_in_presence',
      sql`(${table.checkInOutcome} IS NULL) = (${table.checkedInAt} IS NULL)`,
    ),
    check(
      'ck_focus_sessions_check_in_note',
      sql`${table.checkInNote} IS NULL OR (${table.checkInOutcome} IS NOT NULL AND char_length(${table.checkInNote}) BETWEEN 1 AND 280)`,
    ),
    check(
      'ck_focus_sessions_check_in_ended',
      sql`${table.checkInOutcome} IS NULL OR ${table.status} <> 'in_progress'`,
    ),
    // FQ1.
    check(
      'ck_focus_sessions_check_in_quality',
      sql`${table.checkInQuality} IS NULL OR (${table.checkInOutcome} IS NOT NULL AND ${table.checkInQuality} BETWEEN 1 AND 5)`,
    ),
    // RI1.
    check(
      'ck_focus_sessions_share_intention',
      sql`NOT ${table.shareIntention} OR (${table.roomId} IS NOT NULL AND ${table.taskId} IS NOT NULL)`,
    ),
    // At most one in-progress session per user. It also serves every scan of in-progress
    // sessions (the reconciler sweep, stale cleanup), since it holds only those rows.
    uniqueIndex('uq_focus_sessions_user_id_in_progress')
      .on(table.userId)
      .where(sql`${table.status} = 'in_progress'`),
    // History, newest first (Phase 5), and the ON DELETE CASCADE from users.
    index('ix_focus_sessions_user_id_started_at').on(table.userId, table.startedAt.desc()),
    // RF1: the participants of a run, and the sweep of in-progress room sessions.
    index('ix_focus_sessions_room_run_in_progress')
      .on(table.roomId, table.focusRunId)
      .where(sql`${table.status} = 'in_progress'`),
  ],
);

// Phase 6: rooms and membership (docs/domain/model.md, decisions D8, D9, D16, M1–M10).
// Persistent shared spaces: presence, knocks and chat are Redis-only. The phase durations
// are saved here (D16); the live timer arrives in Phase 7. The host also has a
// `room_members` row, created in the same transaction as the room (a rule the service
// keeps; the database cannot express it).
export const rooms = pgTable(
  'rooms',
  {
    id: uuid().notNull(),
    // Six characters from an alphabet without look-alikes (M2), uppercase.
    code: text().notNull(),
    name: text().notNull(),
    // RESTRICT until account deletion is decided (D2): a host cannot be deleted while
    // their rooms exist.
    hostId: uuid().notNull(),
    isPrivate: boolean().notNull(),
    focusSeconds: integer().notNull().default(1500),
    shortBreakSeconds: integer().notNull().default(300),
    longBreakSeconds: integer().notNull().default(900),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    primaryKey({ name: 'pk_rooms', columns: [table.id] }),
    foreignKey({
      name: 'fk_rooms_host_id',
      columns: [table.hostId],
      foreignColumns: [users.id],
    }).onDelete('restrict'),
    uniqueIndex('uq_rooms_code').on(table.code),
    check('ck_rooms_code', sql`${table.code} ~ '^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$'`),
    check('ck_rooms_name', sql`char_length(${table.name}) BETWEEN 1 AND 60`),
    // M3: duration bounds, in whole seconds.
    check('ck_rooms_focus_seconds', sql`${table.focusSeconds} BETWEEN 60 AND 14400`),
    check('ck_rooms_short_break_seconds', sql`${table.shortBreakSeconds} BETWEEN 60 AND 3600`),
    check('ck_rooms_long_break_seconds', sql`${table.longBreakSeconds} BETWEEN 60 AND 7200`),
    // The ON DELETE RESTRICT check of users and "rooms I host".
    index('ix_rooms_host_id').on(table.hostId),
  ],
);

export const roomMembers = pgTable(
  'room_members',
  {
    roomId: uuid().notNull(),
    userId: uuid().notNull(),
    joinedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ name: 'pk_room_members', columns: [table.roomId, table.userId] }),
    foreignKey({
      name: 'fk_room_members_room_id',
      columns: [table.roomId],
      foreignColumns: [rooms.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'fk_room_members_user_id',
      columns: [table.userId],
      foreignColumns: [users.id],
    }).onDelete('cascade'),
    // "My Rooms": a user's rooms, most recently joined first, and the users cascade.
    index('ix_room_members_user_id_joined_at').on(table.userId, table.joinedAt.desc()),
  ],
);

// Room blocks (B1–B8): a durable per-room list of people the host removed AND forbade to
// return. Separate from `room_members` (membership is deleted on removal; a block is what
// survives it). Deleting the room or the user removes their blocks (cascade); blocks are
// host-managed and carry no other history.
export const roomBlocks = pgTable(
  'room_blocks',
  {
    id: uuid().notNull(),
    roomId: uuid().notNull(),
    userId: uuid().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ name: 'pk_room_blocks', columns: [table.id] }),
    foreignKey({
      name: 'fk_room_blocks_room_id',
      columns: [table.roomId],
      foreignColumns: [rooms.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'fk_room_blocks_user_id',
      columns: [table.userId],
      foreignColumns: [users.id],
    }).onDelete('cascade'),
    // One block per person per room; also the join/knock check and the host's list.
    uniqueIndex('uq_room_blocks_room_id_user_id').on(table.roomId, table.userId),
    // The users ON DELETE CASCADE.
    index('ix_room_blocks_user_id').on(table.userId),
  ],
);

// Parked thoughts (PT1): a distraction noted during a session ("email Ravi") so it does not
// break the focus. Kept until the user turns it into a task or lets it go, so it is durable
// user data (PostgreSQL). The session it came from is optional; deleting the user removes
// their thoughts (cascade). No ON DELETE action on the session (P1): sessions are never
// deleted on their own.
export const parkedThoughts = pgTable(
  'parked_thoughts',
  {
    id: uuid().notNull(),
    userId: uuid().notNull(),
    sessionId: uuid(),
    body: text().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ name: 'pk_parked_thoughts', columns: [table.id] }),
    foreignKey({
      name: 'fk_parked_thoughts_user_id',
      columns: [table.userId],
      foreignColumns: [users.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'fk_parked_thoughts_session_id',
      columns: [table.sessionId],
      foreignColumns: [focusSessions.id],
    }),
    // The same limit as a task title, so every thought can become a task unchanged.
    check('ck_parked_thoughts_body_length', sql`char_length(${table.body}) BETWEEN 1 AND 200`),
    // The user's list, newest first (UUIDv7 ids sort by creation), and the cascade.
    index('ix_parked_thoughts_user_id_id').on(table.userId, table.id.desc()),
  ],
);

// Weekly priorities (WR1): the user's top three tasks for one week, chosen in the weekly
// review. `week_start` is the Monday of the user's local week (the client's time zone, WR3).
// The task must be the user's own (composite key); no ON DELETE action (P1: tasks are
// soft-deleted and disappear only with their user, whose rows cascade away first here).
export const weeklyPriorities = pgTable(
  'weekly_priorities',
  {
    id: uuid().notNull(),
    userId: uuid().notNull(),
    weekStart: date({ mode: 'string' }).notNull(),
    position: smallint().notNull(),
    taskId: uuid().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ name: 'pk_weekly_priorities', columns: [table.id] }),
    foreignKey({
      name: 'fk_weekly_priorities_user_id',
      columns: [table.userId],
      foreignColumns: [users.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'fk_weekly_priorities_task_id',
      columns: [table.taskId, table.userId],
      foreignColumns: [tasks.id, tasks.userId],
    }),
    check('ck_weekly_priorities_position', sql`${table.position} BETWEEN 1 AND 3`),
    check(
      'ck_weekly_priorities_week_start_monday',
      sql`extract(isodow from ${table.weekStart}) = 1`,
    ),
    // One task per slot and each task once per week; the first also serves the reads.
    uniqueIndex('uq_weekly_priorities_user_week_position').on(
      table.userId,
      table.weekStart,
      table.position,
    ),
    uniqueIndex('uq_weekly_priorities_user_week_task').on(
      table.userId,
      table.weekStart,
      table.taskId,
    ),
  ],
);

// Steps (SP1): a small checklist inside a task. The task is the same user's (composite key);
// steps go with the task's user (cascade) and are hidden with a soft-deleted task.
export const taskSteps = pgTable(
  'task_steps',
  {
    id: uuid().notNull(),
    taskId: uuid().notNull(),
    userId: uuid().notNull(),
    title: text().notNull(),
    doneAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ name: 'pk_task_steps', columns: [table.id] }),
    foreignKey({
      name: 'fk_task_steps_task_id',
      columns: [table.taskId, table.userId],
      foreignColumns: [tasks.id, tasks.userId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'fk_task_steps_user_id',
      columns: [table.userId],
      foreignColumns: [users.id],
    }).onDelete('cascade'),
    check('ck_task_steps_title_length', sql`char_length(${table.title}) BETWEEN 1 AND 200`),
    // A task's steps in creation order (UUIDv7).
    index('ix_task_steps_task_id_id').on(table.taskId, table.id),
  ],
);

// Focus buddies (BD1): a request from one user to another, accepted or still pending. One
// row per pair whichever way it was asked (the unique index on the ordered pair); deleting
// either user removes it.
export const buddyLinks = pgTable(
  'buddy_links',
  {
    id: uuid().notNull(),
    requesterId: uuid().notNull(),
    addresseeId: uuid().notNull(),
    acceptedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ name: 'pk_buddy_links', columns: [table.id] }),
    foreignKey({
      name: 'fk_buddy_links_requester_id',
      columns: [table.requesterId],
      foreignColumns: [users.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'fk_buddy_links_addressee_id',
      columns: [table.addresseeId],
      foreignColumns: [users.id],
    }).onDelete('cascade'),
    check('ck_buddy_links_not_self', sql`${table.requesterId} <> ${table.addresseeId}`),
    uniqueIndex('uq_buddy_links_pair').using(
      'btree',
      sql`least(${table.requesterId}, ${table.addresseeId})`,
      sql`greatest(${table.requesterId}, ${table.addresseeId})`,
    ),
    index('ix_buddy_links_addressee_id').on(table.addresseeId),
    index('ix_buddy_links_requester_id').on(table.requesterId),
  ],
);

// Scheduled room sessions (SC1): a time the host plans for the room to focus together, once
// or every week. Removed with the room (cascade); the creator is kept for history.
export const roomSchedules = pgTable(
  'room_schedules',
  {
    id: uuid().notNull(),
    roomId: uuid().notNull(),
    createdBy: uuid().notNull(),
    title: text().notNull(),
    startsAt: timestamp({ withTimezone: true }).notNull(),
    durationMinutes: smallint().notNull(),
    repeatsWeekly: boolean().notNull().default(false),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ name: 'pk_room_schedules', columns: [table.id] }),
    foreignKey({
      name: 'fk_room_schedules_room_id',
      columns: [table.roomId],
      foreignColumns: [rooms.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'fk_room_schedules_created_by',
      columns: [table.createdBy],
      foreignColumns: [users.id],
    }).onDelete('cascade'),
    check('ck_room_schedules_title_length', sql`char_length(${table.title}) BETWEEN 1 AND 60`),
    check('ck_room_schedules_duration', sql`${table.durationMinutes} BETWEEN 5 AND 240`),
    index('ix_room_schedules_room_id').on(table.roomId),
  ],
);
