import { describe, expect, it } from 'vitest';

import {
  formatRefreshToken,
  generateRefreshSecret,
  hashRefreshSecret,
  parseRefreshToken,
  refreshHashesMatch,
} from './refresh-token.js';

describe('generateRefreshSecret', () => {
  it('generates high-entropy, unpredictable secrets', () => {
    const secrets = new Set(Array.from({ length: 100 }, () => generateRefreshSecret()));
    expect(secrets.size).toBe(100);
  });

  it('never produces a secret containing a "."', () => {
    // The format relies on "." being a safe, unambiguous separator.
    for (let i = 0; i < 50; i += 1) {
      expect(generateRefreshSecret()).not.toContain('.');
    }
  });
});

describe('formatRefreshToken / parseRefreshToken', () => {
  it('round-trips a sid and secret', () => {
    const token = formatRefreshToken('018f8f3e-0f1a-7c2b-9f4a-2f1b6c9d0e11', 'the-secret');
    expect(parseRefreshToken(token)).toEqual({
      sid: '018f8f3e-0f1a-7c2b-9f4a-2f1b6c9d0e11',
      secret: 'the-secret',
    });
  });

  it('splits on the first "." only, so a secret may not itself contain one', () => {
    // generateRefreshSecret never produces one; this documents the format's assumption.
    const token = '018f8f3e-0f1a-7c2b-9f4a-2f1b6c9d0e11.secret.with.dots';
    expect(parseRefreshToken(token)).toEqual({
      sid: '018f8f3e-0f1a-7c2b-9f4a-2f1b6c9d0e11',
      secret: 'secret.with.dots',
    });
  });

  it('returns undefined for a token with no separator', () => {
    expect(parseRefreshToken('no-separator-here')).toBeUndefined();
  });

  it('returns undefined for an empty sid or empty secret', () => {
    expect(parseRefreshToken('.secret')).toBeUndefined();
    expect(parseRefreshToken('018f8f3e-0f1a-7c2b-9f4a-2f1b6c9d0e11.')).toBeUndefined();
  });

  it('returns undefined for an empty string', () => {
    expect(parseRefreshToken('')).toBeUndefined();
  });

  describe('sid validation', () => {
    it('rejects a sid that is not shaped like a UUID', () => {
      // A malformed sid would otherwise reach PostgreSQL and raise a driver-level
      // "invalid input syntax for type uuid" error instead of a clean 401.
      expect(parseRefreshToken('not-a-uuid.some-secret')).toBeUndefined();
      expect(parseRefreshToken('zz.zz')).toBeUndefined();
    });

    it('rejects an otherwise-valid-looking sid with the wrong length', () => {
      expect(parseRefreshToken('018f8f3e-0f1a-7c2b-9f4a-2f1b6c9d0e1.secret')).toBeUndefined();
    });

    it('accepts a uuidv7-shaped sid case-insensitively', () => {
      const token = '018F8F3E-0F1A-7C2B-9F4A-2F1B6C9D0E11.secret';
      expect(parseRefreshToken(token)?.sid).toBe('018F8F3E-0F1A-7C2B-9F4A-2F1B6C9D0E11');
    });
  });
});

describe('hashRefreshSecret / refreshHashesMatch', () => {
  it('is deterministic', () => {
    expect(hashRefreshSecret('same-secret')).toBe(hashRefreshSecret('same-secret'));
  });

  it('produces different hashes for different secrets', () => {
    expect(hashRefreshSecret('secret-a')).not.toBe(hashRefreshSecret('secret-b'));
  });

  it('matches equal hashes and rejects different ones', () => {
    const hashA = hashRefreshSecret('secret-a');
    const hashB = hashRefreshSecret('secret-b');
    expect(refreshHashesMatch(hashA, hashA)).toBe(true);
    expect(refreshHashesMatch(hashA, hashB)).toBe(false);
  });

  it('rejects hashes of different lengths without throwing', () => {
    expect(refreshHashesMatch('short', hashRefreshSecret('secret'))).toBe(false);
  });
});
