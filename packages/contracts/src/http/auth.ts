import { z } from 'zod';

import { userViewSchema } from './user';

// A generous upper bound only: prevents an unbounded string from reaching the
// password hasher (hashing cost scales with input size), not a policy choice.
const passwordSchema = z.string().min(8).max(256);

export const signupRequestSchema = z.object({
  email: z.email(),
  password: passwordSchema,
  displayName: z.string().trim().min(1).max(50),
});
export type SignupRequest = z.infer<typeof signupRequestSchema>;

export const loginRequestSchema = z.object({
  email: z.email(),
  password: passwordSchema,
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

export const authResponseSchema = z.object({
  user: userViewSchema,
  accessToken: z.string(),
  accessTokenExpiresAt: z.iso.datetime(),
});
export type AuthResponse = z.infer<typeof authResponseSchema>;

export const refreshResponseSchema = z.object({
  accessToken: z.string(),
  accessTokenExpiresAt: z.iso.datetime(),
});
export type RefreshResponse = z.infer<typeof refreshResponseSchema>;
