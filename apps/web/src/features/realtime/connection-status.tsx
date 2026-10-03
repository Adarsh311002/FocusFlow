import type { RealtimeStatus } from './realtime-client';
import { useRealtimeStatus } from './realtime-provider';

const LABELS: Record<RealtimeStatus, string> = {
  idle: 'offline',
  connecting: 'connecting…',
  connected: 'connected',
  reconnecting: 'reconnecting…',
};

/** A small, non-blocking indicator of the live connection (no product features yet). */
export function ConnectionStatus() {
  const status = useRealtimeStatus();
  return (
    <p role="status" aria-live="polite" className="text-xs text-slate-500">
      {`Live connection: ${LABELS[status]}`}
    </p>
  );
}
