import { useState } from 'react';

const BADGE = 'rounded border px-1.5 py-0.5 text-xs';

/** Private or public, as text (never colour alone). */
export function PrivacyBadge({ isPrivate }: { isPrivate: boolean }) {
  return (
    <span className={`${BADGE} border-line text-muted`}>{isPrivate ? 'Private' : 'Public'}</span>
  );
}

export function HostBadge() {
  return <span className={`${BADGE} border-focus/50 bg-focus/10 text-focus`}>Host</span>;
}

/** Shows the code and copies it. A refused clipboard is reported, not hidden. */
export function CopyCodeButton({ code }: { code: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(code);
      setState('copied');
    } catch {
      setState('failed');
    }
  }

  return (
    <span className="inline-flex items-center gap-2">
      <code className="rounded bg-surface-strong px-1.5 py-0.5 font-mono text-sm">{code}</code>
      <button
        type="button"
        onClick={() => {
          void copy();
        }}
        className="rounded-full border border-line bg-surface px-4 py-1.5 transition hover:bg-surface-strong text-xs"
      >
        Copy code
      </button>
      <span role="status" aria-live="polite" className="text-xs text-muted">
        {state === 'copied' && 'Copied'}
        {state === 'failed' && 'Could not copy'}
      </span>
    </span>
  );
}
