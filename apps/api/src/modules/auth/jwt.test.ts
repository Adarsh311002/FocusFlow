import { describe, expect, it } from 'vitest';

import { issueAccessToken, verifyAccessToken } from './jwt.js';

const OPTIONS = {
  keys: [{ kid: 'k1', secret: 'a'.repeat(32) }],
  issuer: 'focus-flow-test',
  audience: 'focus-flow-test',
};

const CLAIMS = {
  userId: '018f8f3e-0f1a-7c2b-9f4a-2f1b6c9d0e11',
  sid: '018f8f3e-0000-7000-8000-000000000001',
};

describe('issueAccessToken / verifyAccessToken', () => {
  it('issues a token that verifies back to the same claims', async () => {
    const { token, expiresAt } = await issueAccessToken(CLAIMS, OPTIONS, 900);

    const verified = await verifyAccessToken(token, OPTIONS);

    expect(verified).toEqual({ ...CLAIMS, expiresAtMs: expiresAt.getTime() });
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('rejects a token signed with a key that is no longer configured', async () => {
    const retiredKeyOptions = { ...OPTIONS, keys: [{ kid: 'retired', secret: 'b'.repeat(32) }] };
    const { token } = await issueAccessToken(CLAIMS, retiredKeyOptions, 900);

    expect(await verifyAccessToken(token, OPTIONS)).toBeUndefined();
  });

  it('verifies against a rotated key set when the old key is still listed', async () => {
    const { token } = await issueAccessToken(CLAIMS, OPTIONS, 900);
    const rotatedOptions = {
      ...OPTIONS,
      keys: [{ kid: 'k2', secret: 'c'.repeat(32) }, ...OPTIONS.keys],
    };

    expect(await verifyAccessToken(token, rotatedOptions)).toMatchObject(CLAIMS);
  });

  it('rejects an expired token', async () => {
    const { token } = await issueAccessToken(CLAIMS, OPTIONS, -1);

    expect(await verifyAccessToken(token, OPTIONS)).toBeUndefined();
  });

  it('rejects a token issued for a different audience', async () => {
    const { token } = await issueAccessToken(CLAIMS, { ...OPTIONS, audience: 'other-app' }, 900);

    expect(await verifyAccessToken(token, OPTIONS)).toBeUndefined();
  });

  it('rejects a token issued by a different issuer', async () => {
    const { token } = await issueAccessToken(CLAIMS, { ...OPTIONS, issuer: 'someone-else' }, 900);

    expect(await verifyAccessToken(token, OPTIONS)).toBeUndefined();
  });

  it('rejects a token whose signature has been tampered with', async () => {
    const { token } = await issueAccessToken(CLAIMS, OPTIONS, 900);
    const tampered = `${token.slice(0, -2)}zz`;

    expect(await verifyAccessToken(tampered, OPTIONS)).toBeUndefined();
  });

  it('rejects a structurally invalid token', async () => {
    expect(await verifyAccessToken('not-a-jwt', OPTIONS)).toBeUndefined();
    expect(await verifyAccessToken('', OPTIONS)).toBeUndefined();
  });

  it('rejects an unsigned "alg: none" token', async () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none', kid: 'k1' })).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({
        sub: CLAIMS.userId,
        sid: CLAIMS.sid,
        iss: OPTIONS.issuer,
        aud: OPTIONS.audience,
      }),
    ).toString('base64url');

    expect(await verifyAccessToken(`${header}.${payload}.`, OPTIONS)).toBeUndefined();
  });
});
