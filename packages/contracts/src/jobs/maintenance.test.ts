import { describe, expect, it } from 'vitest';

import { reconcileJobSchema } from './maintenance';

describe('reconcileJobSchema', () => {
  it.each(['schedule', 'startup', 'recovery'])('accepts the %s trigger', (trigger) => {
    const job = reconcileJobSchema.parse({ schemaVersion: 1, trigger, correlationId: 'c-1' });
    expect(job.trigger).toBe(trigger);
  });

  it('rejects an unknown schema version, so an old worker never runs a newer payload', () => {
    expect(
      reconcileJobSchema.safeParse({ schemaVersion: 2, trigger: 'schedule', correlationId: 'c' })
        .success,
    ).toBe(false);
  });

  it('rejects unknown triggers, missing fields and extra keys', () => {
    expect(
      reconcileJobSchema.safeParse({ schemaVersion: 1, trigger: 'manual', correlationId: 'c' })
        .success,
    ).toBe(false);
    expect(reconcileJobSchema.safeParse({ schemaVersion: 1, trigger: 'schedule' }).success).toBe(
      false,
    );
    expect(
      reconcileJobSchema.safeParse({
        schemaVersion: 1,
        trigger: 'schedule',
        correlationId: 'c',
        userId: 'x',
      }).success,
    ).toBe(false);
  });
});
