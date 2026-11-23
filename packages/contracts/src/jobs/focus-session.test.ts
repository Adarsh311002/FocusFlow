import { describe, expect, it } from 'vitest';

import { soloEndJobSchema, soloGraceJobSchema } from './focus-session';

const SESSION_ID = '01a0ed0d-55de-7d1b-8495-82fb5050d815';
const USER_ID = '01a0ed0d-55de-7d1b-8495-82fb5050d816';

describe('focus-session job payloads', () => {
  it('accept the version-1 end and grace payloads', () => {
    expect(
      soloEndJobSchema.safeParse({
        schemaVersion: 1,
        sessionId: SESSION_ID,
        userId: USER_ID,
        runningSinceMs: 1_791_000_000_000,
      }).success,
    ).toBe(true);
    expect(
      soloGraceJobSchema.safeParse({
        schemaVersion: 1,
        sessionId: SESSION_ID,
        userId: USER_ID,
        disconnectedAtMs: 1_791_000_000_000,
      }).success,
    ).toBe(true);
  });

  it('reject another schema version, so an old worker never runs a newer payload', () => {
    expect(
      soloEndJobSchema.safeParse({
        schemaVersion: 2,
        sessionId: SESSION_ID,
        userId: USER_ID,
        runningSinceMs: 1,
      }).success,
    ).toBe(false);
  });

  it('reject malformed ids, fractional or negative instants, and extra keys', () => {
    const base = { schemaVersion: 1, sessionId: SESSION_ID, userId: USER_ID };
    for (const payload of [
      { ...base, sessionId: 'nope', disconnectedAtMs: 1 },
      { ...base, disconnectedAtMs: 1.5 },
      { ...base, disconnectedAtMs: -1 },
      { ...base, disconnectedAtMs: 1, evidence: 'observed' },
    ]) {
      expect(soloGraceJobSchema.safeParse(payload).success).toBe(false);
    }
  });
});
