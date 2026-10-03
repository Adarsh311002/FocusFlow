import { describe, expect, it } from 'vitest';

import { classifyEpoch, formatEpoch, parseEpoch } from './epoch.js';
import { redisTimeReplyToMs } from './redis.js';

const ID = '01a0ed0d-55de-7d1b-8495-82fb5050d815';

describe('epoch values', () => {
  it('round-trips id and creation time', () => {
    const value = formatEpoch({ id: ID, createdAtMs: 1_790_000_000_123 });
    expect(value).toBe(`${ID}.1790000000123`);
    expect(parseEpoch(value)).toEqual({ id: ID, createdAtMs: 1_790_000_000_123 });
  });

  it.each([
    ['missing', null],
    ['undefined', undefined],
    ['without a creation time', ID],
    ['with a non-numeric creation time', `${ID}.soon`],
    ['with a short id', 'abc.123'],
    ['with trailing data', `${ID}.123.456`],
  ])('treats a %s value as untrustworthy', (_label, raw) => {
    expect(parseEpoch(raw)).toBeUndefined();
  });
});

describe('classifyEpoch', () => {
  it('is "first" when this instance has not seen an epoch yet', () => {
    expect(classifyEpoch(undefined, 'a')).toBe('first');
  });

  it('is "unchanged" for the same value and "changed" for a different one', () => {
    expect(classifyEpoch('a', 'a')).toBe('unchanged');
    expect(classifyEpoch('a', 'b')).toBe('changed');
  });
});

describe('redisTimeReplyToMs', () => {
  it('converts [seconds, microseconds] strings to epoch milliseconds', () => {
    expect(redisTimeReplyToMs(['1790000000', '123999'])).toBe(1_790_000_000_123);
  });

  it('accepts numeric parts too', () => {
    expect(redisTimeReplyToMs([1_790_000_000, 5_000])).toBe(1_790_000_000_005);
  });

  it.each([[null], [['1']], [['a', 'b']], [['1.5', '0']], ['1790000000']])(
    'rejects a malformed reply %j',
    (reply) => {
      expect(() => redisTimeReplyToMs(reply)).toThrow(/TIME/);
    },
  );
});
