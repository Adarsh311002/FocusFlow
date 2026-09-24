import { describe, expect, it } from 'vitest';

import { type AuthSessionSnapshot, decideRefresh } from './refresh-decision.js';
import { hashRefreshSecret } from './refresh-token.js';

const NOW = new Date('2026-01-01T00:00:00.000Z');
const FUTURE = new Date(NOW.getTime() + 60_000);
const PAST = new Date(NOW.getTime() - 60_000);

const hash = (secret: string): string => hashRefreshSecret(secret);

const baseSession = (overrides: Partial<AuthSessionSnapshot> = {}): AuthSessionSnapshot => ({
  currentTokenHash: hash('current-secret'),
  previousTokenHash: null,
  previousValidUntil: null,
  revokedAt: null,
  expiresAt: FUTURE,
  ...overrides,
});

describe('decideRefresh', () => {
  it('is invalid when no session is found', () => {
    expect(decideRefresh(undefined, hash('anything'), NOW)).toEqual({ kind: 'invalid' });
  });

  it('is invalid when the session is revoked, regardless of a matching hash', () => {
    const session = baseSession({ revokedAt: PAST });
    expect(decideRefresh(session, hash('current-secret'), NOW)).toEqual({ kind: 'invalid' });
  });

  it('is invalid when the session has expired, even with a matching current hash', () => {
    const session = baseSession({ expiresAt: PAST });
    expect(decideRefresh(session, hash('current-secret'), NOW)).toEqual({ kind: 'invalid' });
  });

  it('rotates when the presented hash matches the current hash', () => {
    const session = baseSession();
    expect(decideRefresh(session, hash('current-secret'), NOW)).toEqual({ kind: 'rotate' });
  });

  it('is reuse on the very first refresh if the presented hash matches neither (no previous yet)', () => {
    const session = baseSession();
    expect(decideRefresh(session, hash('wrong-secret'), NOW)).toEqual({ kind: 'reuse' });
  });

  it('is overlap when the presented hash matches the previous hash, inside the window', () => {
    const session = baseSession({
      currentTokenHash: hash('new-secret'),
      previousTokenHash: hash('old-secret'),
      previousValidUntil: FUTURE,
    });
    expect(decideRefresh(session, hash('old-secret'), NOW)).toEqual({ kind: 'overlap' });
  });

  it('is reuse when the presented hash matches the previous hash, but the overlap window has passed', () => {
    const session = baseSession({
      currentTokenHash: hash('new-secret'),
      previousTokenHash: hash('old-secret'),
      previousValidUntil: PAST,
    });
    expect(decideRefresh(session, hash('old-secret'), NOW)).toEqual({ kind: 'reuse' });
  });

  it('is reuse when the presented hash matches neither current nor previous', () => {
    const session = baseSession({
      currentTokenHash: hash('new-secret'),
      previousTokenHash: hash('old-secret'),
      previousValidUntil: FUTURE,
    });
    expect(decideRefresh(session, hash('some-other-secret'), NOW)).toEqual({ kind: 'reuse' });
  });

  it('treats the overlap boundary as inclusive (now equal to previousValidUntil still overlaps)', () => {
    const session = baseSession({
      currentTokenHash: hash('new-secret'),
      previousTokenHash: hash('old-secret'),
      previousValidUntil: NOW,
    });
    expect(decideRefresh(session, hash('old-secret'), NOW)).toEqual({ kind: 'overlap' });
  });

  it('never matches a hash against an unrelated secret of the same length', () => {
    const session = baseSession({ currentTokenHash: hash('a'.repeat(43)) });
    expect(decideRefresh(session, hash('b'.repeat(43)), NOW)).toEqual({ kind: 'reuse' });
  });

  describe('two simultaneous refresh requests (same starting state)', () => {
    it('resolves to rotate-then-overlap, never reuse, when the second request re-reads after the first committed', () => {
      // Both requests start from the same row and present the same current secret.
      const startingHash = hash('shared-current-secret');
      const started = baseSession({ currentTokenHash: startingHash });

      // Request A's guarded UPDATE (WHERE current_token_hash = startingHash) wins the
      // race and commits first, producing this new row state.
      const afterFirstRotation = baseSession({
        currentTokenHash: hash('as-issued-by-request-a'),
        previousTokenHash: startingHash,
        previousValidUntil: FUTURE,
      });

      // Request A, deciding against the pre-race row, correctly wants to rotate.
      expect(decideRefresh(started, startingHash, NOW)).toEqual({ kind: 'rotate' });

      // Request B's guarded UPDATE then affects zero rows (current_token_hash no
      // longer equals startingHash), so the service re-reads and re-decides against
      // the post-rotation row using the SAME presented hash it started with.
      expect(decideRefresh(afterFirstRotation, startingHash, NOW)).toEqual({ kind: 'overlap' });
    });
  });

  describe('old refresh token replay (reuse attack)', () => {
    it('is reuse when a token from two rotations ago is replayed', () => {
      const veryOldSecret = 'very-old-secret';
      // The row has moved on twice since veryOldSecret was current; it is neither
      // the current nor the immediately-previous hash any more.
      const session = baseSession({
        currentTokenHash: hash('newest-secret'),
        previousTokenHash: hash('middle-secret'),
        previousValidUntil: FUTURE,
      });
      expect(decideRefresh(session, hash(veryOldSecret), NOW)).toEqual({ kind: 'reuse' });
    });
  });
});
