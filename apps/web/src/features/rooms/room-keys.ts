import type { RoomId } from '@focus-flow/contracts';

// Query keys for room server data. They start with the user id, like every other feature,
// so one user's entries can never be read under another user's keys. Kept free of React so
// the realtime layer can invalidate them without importing the query hooks.

export const roomKeys = {
  all: (userId: string) => ['rooms', userId] as const,
  list: (userId: string) => ['rooms', userId, 'list'] as const,
  detail: (userId: string, roomId: RoomId) => ['rooms', userId, 'detail', roomId] as const,
  members: (userId: string, roomId: RoomId) => ['rooms', userId, 'members', roomId] as const,
};
