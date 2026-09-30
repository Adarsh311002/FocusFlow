import { describe, expect, it } from 'vitest';

import { errorCodeSchema } from '../errors';
import { taskIdSchema } from '../ids';
import { taskPath, taskPaths } from './paths';
import {
  createTaskRequestSchema,
  listTasksQuerySchema,
  setCurrentTaskRequestSchema,
  TASK_LIST_DEFAULT_LIMIT,
  TASK_LIST_MAX_LIMIT,
  TASK_TITLE_MAX_LENGTH,
  taskListResponseSchema,
  taskParamsSchema,
  taskViewSchema,
  updateTaskRequestSchema,
} from './tasks';

const TASK_ID = '01a0ed0d-55de-7d1b-8495-82fb5050d815';
const AT = '2026-09-30T10:00:00.000Z';

describe('createTaskRequestSchema', () => {
  it('trims the title', () => {
    expect(createTaskRequestSchema.parse({ title: '  Write report  ' })).toEqual({
      title: 'Write report',
    });
  });

  it('rejects an empty or whitespace-only title', () => {
    expect(createTaskRequestSchema.safeParse({ title: '' }).success).toBe(false);
    expect(createTaskRequestSchema.safeParse({ title: '   ' }).success).toBe(false);
  });

  it('accepts a title of exactly the maximum length and rejects one character more', () => {
    const max = 'a'.repeat(TASK_TITLE_MAX_LENGTH);
    expect(createTaskRequestSchema.safeParse({ title: max }).success).toBe(true);
    expect(createTaskRequestSchema.safeParse({ title: `${max}a` }).success).toBe(false);
  });

  it('measures the length after trimming', () => {
    const padded = `  ${'a'.repeat(TASK_TITLE_MAX_LENGTH)}  `;
    expect(createTaskRequestSchema.safeParse({ title: padded }).success).toBe(true);
  });

  it('rejects unknown keys such as a client-supplied userId', () => {
    const result = createTaskRequestSchema.safeParse({ title: 'Task', userId: TASK_ID });
    expect(result.success).toBe(false);
  });

  it('rejects a missing or non-string title', () => {
    expect(createTaskRequestSchema.safeParse({}).success).toBe(false);
    expect(createTaskRequestSchema.safeParse({ title: 42 }).success).toBe(false);
  });
});

describe('updateTaskRequestSchema', () => {
  it('applies the same title rules and strictness as create', () => {
    expect(updateTaskRequestSchema.parse({ title: ' Renamed ' })).toEqual({ title: 'Renamed' });
    expect(updateTaskRequestSchema.safeParse({ title: ' ' }).success).toBe(false);
    expect(updateTaskRequestSchema.safeParse({ title: 'x', completed: true }).success).toBe(false);
  });
});

describe('taskParamsSchema', () => {
  it('accepts a UUID task id', () => {
    expect(taskParamsSchema.parse({ taskId: TASK_ID }).taskId).toBe(TASK_ID);
  });

  it('rejects a malformed task id', () => {
    expect(taskParamsSchema.safeParse({ taskId: 'not-a-uuid' }).success).toBe(false);
  });
});

describe('listTasksQuerySchema', () => {
  it('defaults to open tasks and the default limit', () => {
    expect(listTasksQuerySchema.parse({})).toEqual({
      status: 'open',
      limit: TASK_LIST_DEFAULT_LIMIT,
    });
  });

  it('coerces a numeric limit from the query string', () => {
    expect(listTasksQuerySchema.parse({ status: 'completed', limit: '10' })).toEqual({
      status: 'completed',
      limit: 10,
    });
  });

  it('bounds the limit', () => {
    expect(listTasksQuerySchema.safeParse({ limit: '0' }).success).toBe(false);
    expect(listTasksQuerySchema.safeParse({ limit: String(TASK_LIST_MAX_LIMIT) }).success).toBe(
      true,
    );
    expect(listTasksQuerySchema.safeParse({ limit: String(TASK_LIST_MAX_LIMIT + 1) }).success).toBe(
      false,
    );
    expect(listTasksQuerySchema.safeParse({ limit: '2.5' }).success).toBe(false);
    expect(listTasksQuerySchema.safeParse({ limit: 'many' }).success).toBe(false);
  });

  it('rejects an unknown status, an empty cursor, and unknown keys', () => {
    expect(listTasksQuerySchema.safeParse({ status: 'deleted' }).success).toBe(false);
    expect(listTasksQuerySchema.safeParse({ cursor: '' }).success).toBe(false);
    expect(listTasksQuerySchema.safeParse({ userId: TASK_ID }).success).toBe(false);
  });
});

describe('taskViewSchema', () => {
  const base = { id: TASK_ID, title: 'Task', createdAt: AT, updatedAt: AT };

  it('accepts an open task without a completion time', () => {
    expect(taskViewSchema.parse({ ...base, status: 'open' }).status).toBe('open');
  });

  it('accepts a completed task with a completion time', () => {
    const task = taskViewSchema.parse({ ...base, status: 'completed', completedAt: AT });
    expect(task.status === 'completed' && task.completedAt).toBe(AT);
  });

  it('rejects a completed task without a completion time', () => {
    expect(taskViewSchema.safeParse({ ...base, status: 'completed' }).success).toBe(false);
  });

  it('rejects a status outside the union', () => {
    expect(taskViewSchema.safeParse({ ...base, status: 'deleted' }).success).toBe(false);
  });
});

describe('taskListResponseSchema', () => {
  it('accepts a last page with a null cursor', () => {
    expect(taskListResponseSchema.parse({ tasks: [], nextCursor: null }).nextCursor).toBeNull();
  });
});

describe('setCurrentTaskRequestSchema', () => {
  it('accepts a task id or null', () => {
    expect(setCurrentTaskRequestSchema.parse({ taskId: TASK_ID }).taskId).toBe(TASK_ID);
    expect(setCurrentTaskRequestSchema.parse({ taskId: null }).taskId).toBeNull();
  });

  it('rejects a missing taskId, a malformed id, and unknown keys', () => {
    expect(setCurrentTaskRequestSchema.safeParse({}).success).toBe(false);
    expect(setCurrentTaskRequestSchema.safeParse({ taskId: 'nope' }).success).toBe(false);
    expect(
      setCurrentTaskRequestSchema.safeParse({ taskId: TASK_ID, userId: TASK_ID }).success,
    ).toBe(false);
  });
});

describe('task paths', () => {
  it('fills the task id into each item template', () => {
    const id = taskIdSchema.parse(TASK_ID);
    expect(taskPath(taskPaths.item, id)).toBe(`/tasks/${TASK_ID}`);
    expect(taskPath(taskPaths.complete, id)).toBe(`/tasks/${TASK_ID}/complete`);
    expect(taskPath(taskPaths.reopen, id)).toBe(`/tasks/${TASK_ID}/reopen`);
  });
});

describe('task error codes', () => {
  it('includes the task error codes', () => {
    expect(errorCodeSchema.parse('TASK_NOT_FOUND')).toBe('TASK_NOT_FOUND');
    expect(errorCodeSchema.parse('TASK_NOT_OPEN')).toBe('TASK_NOT_OPEN');
  });
});
