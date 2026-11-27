import pino from 'pino';
import { describe, expect, it } from 'vitest';

import { createAiClient } from './client.js';

// AI5: how each answer of the Python service becomes a job outcome.

const input = {
  task: { title: 'T', goal: null, estimatedSessions: null, sessionsSpent: 0, steps: [] },
  recentCheckIns: [],
};

const clientAnswering = (respond: () => Response | Promise<Response>) =>
  createAiClient({
    baseUrl: 'http://ai.test',
    token: 'token-token-token',
    timeoutMs: 1_000,
    logger: pino({ level: 'silent' }),
    fetchImpl: () => Promise.resolve(respond()),
  });

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('the AI service client', () => {
  it('passes a successful answer through with its source', async () => {
    const client = clientAnswering(() => json(200, { source: 'model', result: { a: 1 } }));
    expect(await client.firstStep(input)).toEqual({ ok: true, source: 'model', result: { a: 1 } });
  });

  it.each([
    [422, { code: 'declined', message: '' }, 'declined', false],
    [422, { code: 'invalid_output', message: '' }, 'invalid_output', false],
    [503, { code: 'unavailable', message: '' }, 'unavailable', true],
    [502, { code: 'provider_error', message: '' }, 'unavailable', false],
    [401, { code: 'unauthorized', message: '' }, 'unavailable', false],
    [500, 'not json', 'unavailable', true],
  ])('maps %i %j to %s (retryable: %s)', async (status, body, failure, retryable) => {
    const client = clientAnswering(() => json(status, body));
    expect(await client.firstStep(input)).toEqual({ ok: false, failure, retryable });
  });

  it('treats an unreachable service as worth retrying', async () => {
    const client = clientAnswering(() => {
      throw new TypeError('fetch failed');
    });
    expect(await client.weeklyReflection({} as never)).toEqual({
      ok: false,
      failure: 'unavailable',
      retryable: true,
    });
  });

  it('refuses a 200 that is not an answer', async () => {
    const client = clientAnswering(() => json(200, { nope: true }));
    expect(await client.firstStep(input)).toMatchObject({ ok: false, failure: 'invalid_output' });
  });
});
