import { describe, expect, it } from 'vitest';

import { hashPassword, verifyPassword } from './password.js';

describe('hashPassword / verifyPassword', () => {
  it('produces a hash that verifies against the original password', async () => {
    const hash = await hashPassword('a-real-password');

    expect(await verifyPassword(hash, 'a-real-password')).toBe(true);
  });

  it('rejects the wrong password', async () => {
    const hash = await hashPassword('a-real-password');

    expect(await verifyPassword(hash, 'a-different-password')).toBe(false);
  });

  it('produces a different hash each time (random salt)', async () => {
    const [hashA, hashB] = await Promise.all([
      hashPassword('same-password'),
      hashPassword('same-password'),
    ]);

    expect(hashA).not.toBe(hashB);
  });

  it('uses the argon2id variant', async () => {
    const hash = await hashPassword('a-real-password');

    expect(hash.startsWith('$argon2id$')).toBe(true);
  });

  it('never throws on a malformed stored hash — verification just fails', async () => {
    await expect(verifyPassword('not-a-real-hash', 'anything')).resolves.toBe(false);
  });
});
