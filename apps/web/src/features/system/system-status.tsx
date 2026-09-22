import type { DependencyStatus } from '@focus-flow/contracts';
import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { fetchLiveness, fetchReadiness } from '../../lib/api-client';

const livenessQueryKey = ['system', 'liveness'] as const;
const readinessQueryKey = ['system', 'readiness'] as const;

/**
 * One dependency line. The status word is part of the text, so the state is never
 * communicated by colour alone.
 */
function DependencyItem({ name, status }: { name: string; status: DependencyStatus }) {
  const tone = status === 'ok' ? 'text-green-700' : 'text-red-700';
  return <li className={tone}>{`${name}: ${status}`}</li>;
}

/**
 * Phase 0's only feature: proves the browser can reach the API through the dev proxy
 * and reports what the API says about itself.
 */
export function SystemStatus() {
  const liveness = useQuery({ queryKey: livenessQueryKey, queryFn: fetchLiveness });
  const readiness = useQuery({ queryKey: readinessQueryKey, queryFn: fetchReadiness });

  const failure = liveness.error ?? readiness.error;
  const livenessResult = liveness.data;
  const readinessResult = readiness.data;

  let body: ReactNode;

  if (failure !== null) {
    body = (
      <div className="space-y-1">
        <p className="font-medium text-red-700">Unable to reach the API.</p>
        <p className="text-sm text-slate-600">{failure.message}</p>
      </div>
    );
  } else if (livenessResult === undefined || readinessResult === undefined) {
    body = <p className="text-slate-600">Checking the API…</p>;
  } else {
    const isReady = readinessResult.status === 'ready';
    body = (
      <div className="space-y-2">
        <p className={isReady ? 'font-medium text-green-700' : 'font-medium text-red-700'}>
          {isReady ? 'The API is ready.' : 'The API is not ready.'}
        </p>
        <ul className="space-y-1 text-sm">
          <li className="text-green-700">{`liveness: ${livenessResult.status}`}</li>
          <DependencyItem name="postgres" status={readinessResult.checks.postgres} />
          <DependencyItem name="redis" status={readinessResult.checks.redis} />
        </ul>
      </div>
    );
  }

  return (
    <section aria-labelledby="system-status-heading" className="max-w-md space-y-3">
      <h2 id="system-status-heading" className="text-base font-semibold">
        System status
      </h2>
      <div
        role="status"
        aria-live="polite"
        className="rounded-md border border-slate-200 p-4 shadow-sm"
      >
        {body}
      </div>
    </section>
  );
}
