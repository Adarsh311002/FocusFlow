import {
  type AiFailure,
  aiJobPath,
  aiJobResponseSchema,
  type AiJobView,
  aiPaths,
  type TaskId,
  weeklyReflectionResponseSchema,
} from '@focus-flow/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { ApiError } from '../../lib/api-client';
import { authedApiRequest } from '../auth/auth-client';
import { useAuth } from '../auth/auth-context';

// AI features on the web (AI7, AI8): ask, then poll the job every second and a half until
// the worker has finished it. No socket event: the job is short and only this tab waits.

const NO_USER = 'signed-out';
const POLL_MS = 1_500;

function useUserId(): string {
  return useAuth().user?.id ?? NO_USER;
}

export const aiKeys = {
  job: (userId: string, jobId: string) => ['ai', userId, 'job', jobId] as const,
  weekly: (userId: string, week: string) => ['ai', userId, 'weekly', week] as const,
};

export const isActive = (job: AiJobView | null | undefined): boolean =>
  job?.status === 'queued' || job?.status === 'running';

const post = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

/** One job, polled while it is under way. */
export function useAiJob(jobId: string | null) {
  const userId = useUserId();
  return useQuery({
    queryKey: aiKeys.job(userId, jobId ?? 'none'),
    queryFn: async () => (await authedApiRequest(aiJobPath(jobId ?? ''), aiJobResponseSchema)).job,
    enabled: userId !== NO_USER && jobId !== null,
    refetchInterval: (query) => (isActive(query.state.data) ? POLL_MS : false),
  });
}

export function useRequestFirstStep() {
  const userId = useUserId();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (taskId: TaskId) =>
      (await authedApiRequest(aiPaths.firstStep, aiJobResponseSchema, post({ taskId }))).job,
    onSuccess: (job) => {
      queryClient.setQueryData(aiKeys.job(userId, job.id), job);
    },
  });
}

/** The newest reflection of `week`, polled while it is being written. */
export function useWeeklyReflection(week: string) {
  const userId = useUserId();
  return useQuery({
    queryKey: aiKeys.weekly(userId, week),
    queryFn: async () =>
      (
        await authedApiRequest(
          `${aiPaths.weeklyReflection}?week=${encodeURIComponent(week)}`,
          weeklyReflectionResponseSchema,
        )
      ).job,
    enabled: userId !== NO_USER,
    refetchInterval: (query) => (isActive(query.state.data) ? POLL_MS : false),
  });
}

export function useRequestWeeklyReflection(week: string, tz: string) {
  const userId = useUserId();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () =>
      (await authedApiRequest(aiPaths.weeklyReflection, aiJobResponseSchema, post({ week, tz })))
        .job,
    onSuccess: (job) => {
      queryClient.setQueryData(aiKeys.weekly(userId, week), job);
    },
  });
}

/** AI5: what to tell the user when a job failed. */
export const FAILURE_TEXT: Record<AiFailure, string> = {
  unavailable: 'The AI helper is not reachable right now. Try again in a little while.',
  timed_out: 'That took too long. Try again.',
  declined: 'The AI helper could not help with this one.',
  invalid_output: 'The answer came back garbled. Try again.',
};

/** What to tell the user when asking itself was refused. */
export function requestErrorText(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'RATE_LIMITED') {
      return 'That is plenty of AI help for now. Try again in a while.';
    }
    if (error.code === 'AI_JOB_BUSY') {
      return 'The AI helper is still busy with your last request. Try again in a moment.';
    }
  }
  return FAILURE_TEXT.unavailable;
}
