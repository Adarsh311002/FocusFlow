import { describe, expect, it } from 'vitest';

import { isOnlineAt, planSync, splitEntry } from './store.js';

describe('splitEntry', () => {
  it('splits on the first colon', () => {
    expect(splitEntry('01a0ed0d-55de-7d1b-8495-82fb5050d815:Ab_c-12')).toEqual([
      '01a0ed0d-55de-7d1b-8495-82fb5050d815',
      'Ab_c-12',
    ]);
  });

  it.each(['no-colon', ':leading', 'trailing:', ''])('rejects the malformed entry %j', (entry) => {
    expect(splitEntry(entry)).toBeUndefined();
  });
});

describe('planSync (live sockets against the reverse index)', () => {
  const a1 = { userId: 'user-a', socketId: 's1' };
  const a2 = { userId: 'user-a', socketId: 's2' };
  const b1 = { userId: 'user-b', socketId: 's3' };

  it('plans nothing when the index matches the live sockets', () => {
    expect(planSync(['user-a:s1', 'user-b:s3'], [a1, b1])).toEqual({ missing: [], stale: [] });
    expect(planSync([], [])).toEqual({ missing: [], stale: [] });
  });

  it('adds live sockets missing from the index', () => {
    expect(planSync(['user-a:s1'], [a1, a2, b1])).toEqual({ missing: [a2, b1], stale: [] });
  });

  it('removes indexed entries with no live socket (including malformed ones)', () => {
    expect(planSync(['user-a:s1', 'user-a:s2', 'garbage'], [a1])).toEqual({
      missing: [],
      stale: ['user-a:s2', 'garbage'],
    });
  });

  it('adds and removes in the same plan', () => {
    expect(planSync(['user-a:s1', 'user-a:s2'], [a1, b1])).toEqual({
      missing: [b1],
      stale: ['user-a:s2'],
    });
  });
});

describe('isOnlineAt', () => {
  const heartbeats = new Map([
    ['live', 10_000],
    ['dead', 1_000],
  ]);

  it('counts only entries on an instance whose heartbeat is within the TTL', () => {
    expect(isOnlineAt(['live:s1'], heartbeats, 12_000, 3_000)).toBe(true);
    expect(isOnlineAt(['dead:s1'], heartbeats, 12_000, 3_000)).toBe(false);
    expect(isOnlineAt(['gone:s1'], heartbeats, 12_000, 3_000)).toBe(false);
    expect(isOnlineAt(['dead:s1', 'live:s2'], heartbeats, 12_000, 3_000)).toBe(true);
    expect(isOnlineAt([], heartbeats, 12_000, 3_000)).toBe(false);
  });

  it('treats a heartbeat exactly at the TTL boundary as live', () => {
    expect(isOnlineAt(['live:s1'], heartbeats, 13_000, 3_000)).toBe(true);
    expect(isOnlineAt(['live:s1'], heartbeats, 13_001, 3_000)).toBe(false);
  });
});
