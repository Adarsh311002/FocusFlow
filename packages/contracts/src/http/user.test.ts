import { describe, expect, it } from 'vitest';

import { userViewSchema } from './user';

const user = {
  id: '018f8f3e-0f1a-7c2b-9f4a-2f1b6c9d0e11',
  email: 'person@example.com',
  emailVerified: false,
  displayName: 'Ada',
  avatarUrl: null,
  identities: [],
};

describe('userViewSchema currentTaskId', () => {
  it('accepts no current task', () => {
    expect(userViewSchema.parse({ ...user, currentTaskId: null }).currentTaskId).toBeNull();
  });

  it('accepts a task id as the current task', () => {
    const taskId = '01a0ed0d-55de-7d1b-8495-82fb5050d815';
    expect(userViewSchema.parse({ ...user, currentTaskId: taskId }).currentTaskId).toBe(taskId);
  });

  it('requires the field and rejects a malformed id', () => {
    expect(userViewSchema.safeParse(user).success).toBe(false);
    expect(userViewSchema.safeParse({ ...user, currentTaskId: 'nope' }).success).toBe(false);
  });
});
