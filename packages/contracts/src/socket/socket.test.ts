import { describe, expect, it } from 'vitest';

import { authSessionIdSchema } from '../ids';
import { timeSyncAckSchema, timeSyncRequestSchema } from './events';
import { connectErrorDataSchema, handshakeAuthSchema } from './handshake';

const UUID = '01a0ed0d-55de-7d1b-8495-82fb5050d815';

describe('handshakeAuthSchema', () => {
  it('accepts a token', () => {
    expect(handshakeAuthSchema.parse({ token: 'a.b.c' })).toEqual({ token: 'a.b.c' });
  });

  it('rejects a missing or empty token', () => {
    expect(handshakeAuthSchema.safeParse({}).success).toBe(false);
    expect(handshakeAuthSchema.safeParse({ token: '' }).success).toBe(false);
    expect(handshakeAuthSchema.safeParse({ token: 42 }).success).toBe(false);
  });

  it('rejects identity riding along with the token (F7)', () => {
    expect(handshakeAuthSchema.safeParse({ token: 'a.b.c', userId: UUID }).success).toBe(false);
  });
});

describe('connectErrorDataSchema', () => {
  it.each(['UNAUTHENTICATED', 'SESSION_REVOKED', 'INTERNAL'])('accepts %s', (code) => {
    expect(connectErrorDataSchema.parse({ code }).code).toBe(code);
  });

  it('rejects codes outside the handshake set', () => {
    expect(connectErrorDataSchema.safeParse({ code: 'TASK_NOT_FOUND' }).success).toBe(false);
  });
});

describe('time:sync', () => {
  it('accepts a non-negative integer client send time', () => {
    expect(timeSyncRequestSchema.parse({ clientSentAtMs: 1_790_000_000_000 }).clientSentAtMs).toBe(
      1_790_000_000_000,
    );
  });

  it('rejects negative, fractional, missing and extra fields', () => {
    expect(timeSyncRequestSchema.safeParse({ clientSentAtMs: -1 }).success).toBe(false);
    expect(timeSyncRequestSchema.safeParse({ clientSentAtMs: 1.5 }).success).toBe(false);
    expect(timeSyncRequestSchema.safeParse({}).success).toBe(false);
    expect(timeSyncRequestSchema.safeParse({ clientSentAtMs: 1, userId: UUID }).success).toBe(
      false,
    );
  });
});

describe('timeSyncAckSchema', () => {
  const schema = timeSyncAckSchema;

  it('accepts a success acknowledgement with the result', () => {
    const ack = schema.parse({ ok: true, serverNowMs: 5 });
    expect(ack.ok && ack.serverNowMs).toBe(5);
  });

  it('accepts an error acknowledgement with a known code', () => {
    const ack = schema.parse({ ok: false, error: { code: 'VALIDATION_FAILED', message: 'x' } });
    expect(ack.ok).toBe(false);
  });

  it('rejects a success without the result and an error with an unknown code', () => {
    expect(schema.safeParse({ ok: true }).success).toBe(false);
    expect(schema.safeParse({ ok: false, error: { code: 'NOPE', message: 'x' } }).success).toBe(
      false,
    );
  });
});

describe('authSessionIdSchema', () => {
  it('accepts a UUID and rejects anything else', () => {
    expect(authSessionIdSchema.parse(UUID)).toBe(UUID);
    expect(authSessionIdSchema.safeParse('sid').success).toBe(false);
  });
});
