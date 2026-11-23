import { describe, expect, it } from 'vitest';

import { parseDedupeValue } from './chat.js';
import {
  instanceIndexEntry,
  isLiveEntry,
  type LocalRoomSocket,
  parseIndexEntry,
  planRoomSync,
  userSetEntry,
} from './entries.js';

const local = (roomId: string, userId: string, socketId: string): LocalRoomSocket => ({
  roomId,
  userId,
  socketId,
  displayName: 'Someone',
  avatarUrl: null,
});

describe('room presence entries', () => {
  it('round-trips an index entry', () => {
    const ref = { roomId: 'r1', userId: 'u1', socketId: 's_1-x' };
    expect(parseIndexEntry(instanceIndexEntry(ref))).toEqual(ref);
    expect(userSetEntry('i1', 's1')).toBe('i1:s1');
  });

  it('refuses malformed index entries', () => {
    for (const entry of ['', 'r', 'r:u', 'r:u:', ':u:s', 'r::s']) {
      expect(parseIndexEntry(entry)).toBeUndefined();
    }
  });

  it('plans additions and removals in both directions', () => {
    const kept = local('r', 'u1', 's1');
    const missing = local('r', 'u2', 's2');
    const plan = planRoomSync([instanceIndexEntry(kept), 'r:u3:s3'], [kept, missing]);
    expect(plan.missing).toEqual([missing]);
    expect(plan.stale).toEqual(['r:u3:s3']);
  });

  it('plans nothing when both sides agree', () => {
    const socket = local('r', 'u1', 's1');
    expect(planRoomSync([instanceIndexEntry(socket)], [socket])).toEqual({
      missing: [],
      stale: [],
    });
  });

  it('counts an entry only while its instance heartbeat is fresh', () => {
    const beats = new Map([
      ['live', 9_500],
      ['old', 1_000],
    ]);
    expect(isLiveEntry('live:s', beats, 10_000, 2_000)).toBe(true);
    expect(isLiveEntry('old:s', beats, 10_000, 2_000)).toBe(false);
    expect(isLiveEntry('unknown:s', beats, 10_000, 2_000)).toBe(false);
    expect(isLiveEntry('nocolon', beats, 10_000, 2_000)).toBe(false);
  });
});

describe('parseDedupeValue', () => {
  it('reads messageId:sentAtMs', () => {
    expect(parseDedupeValue('abc:1700')).toEqual({ messageId: 'abc', sentAtMs: 1700 });
  });

  it('refuses anything else', () => {
    expect(parseDedupeValue(null)).toBeUndefined();
    expect(parseDedupeValue('abc')).toBeUndefined();
    expect(parseDedupeValue('abc:x')).toBeUndefined();
    expect(parseDedupeValue('abc:-1')).toBeUndefined();
  });
});
