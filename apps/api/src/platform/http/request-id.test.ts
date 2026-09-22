import { describe, expect, it } from 'vitest';

import { readIncomingId } from './request-id.js';

describe('readIncomingId', () => {
  it('passes a well-formed client id through', () => {
    expect(readIncomingId('req-123.abc:DEF_4')).toBe('req-123.abc:DEF_4');
  });

  it('trims surrounding whitespace', () => {
    expect(readIncomingId('  abc-123  ')).toBe('abc-123');
  });

  it('returns undefined when the header is absent or blank', () => {
    expect(readIncomingId(undefined)).toBeUndefined();
    expect(readIncomingId('   ')).toBeUndefined();
  });

  it('rejects an oversized id', () => {
    expect(readIncomingId('a'.repeat(129))).toBeUndefined();
    expect(readIncomingId('a'.repeat(128))).toBe('a'.repeat(128));
  });

  it('rejects characters that could forge a log line or split a header', () => {
    expect(readIncomingId('abc\r\nx-injected: 1')).toBeUndefined();
    expect(readIncomingId('abc\nfake log line')).toBeUndefined();
    expect(readIncomingId('abc def')).toBeUndefined();
    expect(readIncomingId('<script>')).toBeUndefined();
  });

  it('uses the first value when the header arrives more than once', () => {
    expect(readIncomingId(['first-id', 'second-id'])).toBe('first-id');
    expect(readIncomingId(['bad id', 'good-id'])).toBeUndefined();
  });
});
