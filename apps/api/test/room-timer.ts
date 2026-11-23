import type { TimerCommand, TimerView } from '@focus-flow/contracts';
import type { Socket } from 'socket.io-client';
import { expect } from 'vitest';

import type { TimerState } from '../src/modules/room-timer/types.js';
import type { Runtime } from '../src/platform/runtime.js';
import { emitWithAck, eventually, recordEvents } from './sockets.js';

// Helpers for the room timer integration tests.

export type TimerAnswer = {
  ok: boolean;
  timer?: TimerView;
  serverNowMs?: number;
  error?: {
    code: string;
    message: string;
    details?: { timer: TimerView; serverNowMs: number };
  };
};

export type TimerEvent = { roomId: string; timer: TimerView; serverNowMs: number };

export const timerCommand = (
  socket: Socket,
  roomId: string,
  command: TimerCommand | Record<string, unknown>,
): Promise<TimerAnswer> =>
  emitWithAck<TimerAnswer>(socket, 'room:timer:command', { roomId, command });

/** The stored timer of a room (materialising it like a join would). */
export const currentTimer = async (runtime: Runtime, roomId: string): Promise<TimerState> => {
  const current = await runtime.roomTimer.service.get(roomId);
  if (current === undefined) {
    throw new Error('the room has no timer');
  }
  return current.state;
};

/**
 * Writes a running state straight through the store (version + 1), bypassing the machine
 * and the change listeners, so a test can have a phase that ends in `endsInMs` (or ended
 * `-endsInMs` ago) without waiting the 60 s of the shortest real phase. No job is scheduled.
 */
export const craftRunning = async (
  runtime: Runtime,
  roomId: string,
  options: { durationMs: number; endsInMs: number },
): Promise<{ state: TimerState; nowMs: number; endsAtMs: number }> => {
  const { store } = runtime.roomTimer;
  await currentTimer(runtime, roomId);
  const { state, nowMs } = await store.read(roomId);
  if (state === undefined) {
    throw new Error('the room has no timer');
  }
  const endsAtMs = nowMs + options.endsInMs;
  const next: TimerState = {
    ...state,
    status: 'running',
    durationMs: options.durationMs,
    elapsedBeforeMs: 0,
    segmentStartedAtMs: endsAtMs - options.durationMs,
    version: state.version + 1,
  };
  expect(await store.write(roomId, state.version, next)).toBe('ok');
  return { state: next, nowMs, endsAtMs };
};

/**
 * A positive barrier for "no further event arrived": sends a chat message through `send`
 * and waits until `receiver` hears it. Everything the same instance emitted to the room
 * before the probe has then been delivered (one publisher, one ordered channel), so a
 * negative assertion made afterwards is not just a slow network.
 */
export const probeRoom = async (
  send: (body: string) => Promise<unknown>,
  receiver: Socket,
): Promise<void> => {
  const heard = recordEvents<{ body: string }>(receiver, 'room:chat:message');
  const body = `probe ${crypto.randomUUID()}`;
  await send(body);
  await eventually(() => heard.some((message) => message.body === body));
};
