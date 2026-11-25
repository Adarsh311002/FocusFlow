import { describe, expect, it } from 'vitest';

import { clientAddressOf } from './connection-guards.js';

describe('clientAddressOf (S1)', () => {
  const handshake = (forwarded?: string) => ({
    address: '10.0.0.2',
    headers: forwarded === undefined ? {} : { 'x-forwarded-for': forwarded },
  });

  it('uses the socket address when not behind a proxy, whatever the header says', () => {
    expect(clientAddressOf(handshake('203.0.113.9'), false)).toBe('10.0.0.2');
  });

  it('uses the last forwarded hop behind one proxy, like Express with trust proxy 1', () => {
    // A client may send its own X-Forwarded-For; Nginx appends the address it saw last.
    expect(clientAddressOf(handshake('1.2.3.4, 203.0.113.9'), true)).toBe('203.0.113.9');
    expect(clientAddressOf(handshake(' 203.0.113.9 '), true)).toBe('203.0.113.9');
  });

  it('falls back to the socket address without a usable header', () => {
    expect(clientAddressOf(handshake(), true)).toBe('10.0.0.2');
    expect(clientAddressOf(handshake('   '), true)).toBe('10.0.0.2');
  });
});
