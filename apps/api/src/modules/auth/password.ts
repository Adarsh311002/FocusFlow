import argon2 from 'argon2';

/**
 * argon2id (I5). `argon2.hash`/`argon2.verify` use argon2id by default and compare
 * in constant time internally — never compare hashes with `===`.
 */
export const hashPassword = (password: string): Promise<string> => argon2.hash(password);

export const verifyPassword = async (hash: string, password: string): Promise<boolean> => {
  try {
    return await argon2.verify(hash, password);
  } catch {
    // A hash from a future/foreign format is a verification failure, not a crash.
    return false;
  }
};
