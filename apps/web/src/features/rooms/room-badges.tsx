import { useState } from 'react';

const BADGE = 'rounded border px-1.5 py-0.5 text-xs';

/** Private or public, as text (never colour alone). */
export function PrivacyBadge({ isPrivate }: { isPrivate: boolean }) {
  return (
    <span className={`${BADGE} border-slate-300 text-slate-700`}>
      {isPrivate ? 'Private' : 'Public'}
    </span>
  );
}

export function HostBadge() {
  return <span className={`${BADGE} border-slate-900 text-slate-900`}>Host</span>;
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
      <code className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-sm">{code}</code>
      <button
        type="button"
        onClick={() => {
          void copy();
        }}
        className="rounded border border-slate-300 px-2 py-0.5 text-xs"
      >
        Copy code
      </button>
      <span role="status" aria-live="polite" className="text-xs text-slate-600">
        {state === 'copied' && 'Copied'}
        {state === 'failed' && 'Could not copy'}
      </span>
    </span>
  );
}
