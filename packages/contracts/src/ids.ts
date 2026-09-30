import { z } from 'zod';

/**
 * Branded IDs keep identifier kinds apart at compile time, so a RoomId can never
 * be passed where a UserId is expected. Values are produced by parsing, never by
 * casting (docs/architecture/contracts.md).
 */
export const userIdSchema = z.uuid().brand<'UserId'>();
export type UserId = z.infer<typeof userIdSchema>;

export const taskIdSchema = z.uuid().brand<'TaskId'>();
export type TaskId = z.infer<typeof taskIdSchema>;
