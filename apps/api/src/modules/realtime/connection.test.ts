import { describe, expect, it } from 'vitest';

import { handleTimeSync } from './connection.js';

const clock = (reply: unknown) => ({
  time: () => (reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply)),
});

describe('handleTimeSync', () => {
  it('acknowledges with the Redis time in milliseconds', async () => {
    const responses: unknown[] = [];

    await handleTimeSync(
      clock(['1790000000', '250000']) as never,
      { clientSentAtMs: 1 },
      (r: unknown) => responses.push(r),
    );

    expect(responses).toEqual([{ ok: true, serverNowMs: 1_790_000_000_250 }]);
  });

  it('answers VALIDATION_FAILED for an invalid payload without reading the clock', async () => {
    const responses: unknown[] = [];

    await handleTimeSync(
      clock(new Error('must not be read')) as never,
      { nope: true },
      (r: unknown) => responses.push(r),
    );

    expect(responses).toEqual([
      { ok: false, error: { code: 'VALIDATION_FAILED', message: 'Invalid time:sync payload.' } },
    ]);
  });

  it('answers INTERNAL when Redis cannot be read', async () => {
    const responses: unknown[] = [];

    await handleTimeSync(clock(new Error('down')) as never, { clientSentAtMs: 1 }, (r: unknown) =>
      responses.push(r),
    );

    expect(responses).toMatchObject([{ ok: false, error: { code: 'INTERNAL' } }]);
  });

  it('does nothing when the client sent no acknowledgement callback', async () => {
    await expect(
      handleTimeSync(clock(['1', '0']) as never, { clientSentAtMs: 1 }, undefined),
    ).resolves.toBeUndefined();
  });
});
