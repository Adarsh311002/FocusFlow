import { describe, expect, it } from 'vitest';

import { decodeHistoryCursor, encodeHistoryCursor } from './review-cursor.js';

const SESSION_ID = '01a0ed0d-55de-7d1b-8495-82fb5050d815';

describe('history cursor', () => {
  it('round-trips a session id', () => {
    expect(decodeHistoryCursor(encodeHistoryCursor(SESSION_ID))).toBe(SESSION_ID);
  });

  it.each(['not-a-cursor', '', Buffer.from('1700000000000.x').toString('base64url'), SESSION_ID])(
    'rejects %j as a 400',
    (cursor) => {
      expect(() => decodeHistoryCursor(cursor)).toThrow(
        expect.objectContaining({ code: 'VALIDATION_FAILED', status: 400 }),
      );
    },
  );
});
