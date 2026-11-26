import {
  type AiFailure,
  type AiFirstStepInput,
  aiServiceAnswerSchema,
  aiServiceErrorSchema,
  type AiSource,
  type AiWeeklyInput,
} from '@focus-flow/contracts';
import type { Logger } from 'pino';

// The Node side of the Node ↔ Python boundary (AI4): one internal HTTP call per job, with
// the shared token. Every outcome is a value; nothing here throws.

export type AiCallOutcome =
  | { readonly ok: true; readonly source: AiSource; readonly result: unknown }
  | {
      readonly ok: false;
      readonly failure: AiFailure;
      /** Worth another attempt of the same job (the service or the model was unreachable). */
      readonly retryable: boolean;
    };

export type AiClient = {
  readonly firstStep: (input: AiFirstStepInput) => Promise<AiCallOutcome>;
  readonly weeklyReflection: (input: AiWeeklyInput) => Promise<AiCallOutcome>;
};

type ClientOptions = {
  readonly baseUrl: string;
  readonly token: string;
  readonly timeoutMs: number;
  readonly logger: Logger;
  readonly fetchImpl?: typeof fetch;
};

const unavailable = (retryable: boolean): AiCallOutcome => ({
  ok: false,
  failure: 'unavailable',
  retryable,
});

export const createAiClient = ({
  baseUrl,
  token,
  timeoutMs,
  logger,
  fetchImpl = fetch,
}: ClientOptions): AiClient => {
  const call = async (path: string, input: unknown): Promise<AiCallOutcome> => {
    let response: Response;
    try {
      response = await fetchImpl(new URL(path, baseUrl), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Internal-Token': token },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      logger.warn({ err: error, path }, 'AI service unreachable');
      return unavailable(true);
    }
    const body: unknown = await response.json().catch(() => null);
    if (response.ok) {
      const answer = aiServiceAnswerSchema.safeParse(body);
      return answer.success
        ? { ok: true, source: answer.data.source, result: answer.data.result }
        : { ok: false, failure: 'invalid_output', retryable: false };
    }
    const error = aiServiceErrorSchema.safeParse(body);
    const code = error.success ? error.data.code : undefined;
    logger.warn({ path, status: response.status, code }, 'AI service refused the request');
    switch (code) {
      case 'declined':
        return { ok: false, failure: 'declined', retryable: false };
      case 'invalid_output':
        return { ok: false, failure: 'invalid_output', retryable: false };
      case 'unavailable':
        return unavailable(true);
      default:
        // provider_error / unauthorized / anything unexpected: a configuration problem
        // another attempt will not fix (5xx without a body may be a restart: retry those).
        return unavailable(code === undefined && response.status >= 500);
    }
  };

  return {
    firstStep: (input) => call('/v1/first-step', input),
    weeklyReflection: (input) => call('/v1/weekly-reflection', input),
  };
};
