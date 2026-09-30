import { afterEach, describe, expect, it } from 'vitest';

import { clearAccessToken, getAccessToken, setAccessToken } from './token-store';

afterEach(() => {
  clearAccessToken();
});

describe('token-store', () => {
  it('starts empty, because a page load never inherits a token', () => {
    expect(getAccessToken()).toBeNull();
  });

  it('returns the token that was set', () => {
    setAccessToken('token-a');

    expect(getAccessToken()).toBe('token-a');
  });

  it('replaces the previous token on the next set', () => {
    setAccessToken('token-a');
    setAccessToken('token-b');

    expect(getAccessToken()).toBe('token-b');
  });

  it('clears through setAccessToken(null)', () => {
    setAccessToken('token-a');
    setAccessToken(null);

    expect(getAccessToken()).toBeNull();
  });

  it('clears through clearAccessToken()', () => {
    setAccessToken('token-a');
    clearAccessToken();

    expect(getAccessToken()).toBeNull();
  });
});
