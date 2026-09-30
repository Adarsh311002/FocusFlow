import { describe, expect, it } from 'vitest';

import {
  authResponseSchema,
  loginRequestSchema,
  refreshResponseSchema,
  signupRequestSchema,
} from './auth';

describe('signupRequestSchema', () => {
  it('accepts a well-formed signup', () => {
    const result = signupRequestSchema.parse({
      email: 'person@example.com',
      password: 'a-long-enough-password',
      displayName: 'Ada',
    });
    expect(result.email).toBe('person@example.com');
  });

  it('rejects a password shorter than 8 characters', () => {
    expect(
      signupRequestSchema.safeParse({
        email: 'person@example.com',
        password: 'short',
        displayName: 'Ada',
      }).success,
    ).toBe(false);
  });

  it('rejects an empty display name', () => {
    expect(
      signupRequestSchema.safeParse({
        email: 'person@example.com',
        password: 'a-long-enough-password',
        displayName: '',
      }).success,
    ).toBe(false);
  });

  it('rejects an invalid email', () => {
    expect(
      signupRequestSchema.safeParse({
        email: 'not-an-email',
        password: 'a-long-enough-password',
        displayName: 'Ada',
      }).success,
    ).toBe(false);
  });
});

describe('loginRequestSchema', () => {
  it('accepts email and password only', () => {
    const result = loginRequestSchema.parse({
      email: 'person@example.com',
      password: 'a-long-enough-password',
    });
    expect(result).toEqual({ email: 'person@example.com', password: 'a-long-enough-password' });
  });
});

describe('authResponseSchema', () => {
  it('accepts a well-formed response', () => {
    const result = authResponseSchema.parse({
      user: {
        id: '018f8f3e-0f1a-7c2b-9f4a-2f1b6c9d0e11',
        email: 'person@example.com',
        emailVerified: false,
        displayName: 'Ada',
        avatarUrl: null,
        currentTaskId: null,
        identities: [],
      },
      accessToken: 'header.payload.signature',
      accessTokenExpiresAt: new Date().toISOString(),
    });
    expect(result.user.emailVerified).toBe(false);
  });

  it('rejects a non-ISO expiry', () => {
    expect(
      authResponseSchema.safeParse({
        user: {
          id: '018f8f3e-0f1a-7c2b-9f4a-2f1b6c9d0e11',
          email: 'person@example.com',
          emailVerified: false,
          displayName: 'Ada',
          avatarUrl: null,
          currentTaskId: null,
          identities: [],
        },
        accessToken: 'header.payload.signature',
        accessTokenExpiresAt: 'not-a-date',
      }).success,
    ).toBe(false);
  });
});

describe('refreshResponseSchema', () => {
  it('accepts an access token and expiry only', () => {
    const result = refreshResponseSchema.parse({
      accessToken: 'header.payload.signature',
      accessTokenExpiresAt: new Date().toISOString(),
    });
    expect(result.accessToken).toBe('header.payload.signature');
  });
});
