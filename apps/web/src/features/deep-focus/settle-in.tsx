import { useEffect, useRef, useState } from 'react';

// DF5: a 15-second breath before a Deep Focus session starts. Nothing is sent to the
// server until it ends (or is skipped), so cancelling it leaves no session behind.

export const SETTLE_IN_SECONDS = 15;
/** One breath: in for half, out for half. */
const BREATH_SECONDS = 5;

export function SettleIn({
  onDone,
  onCancel,
}: {
  readonly onDone: () => void;
  readonly onCancel: () => void;
}) {
  const [elapsed, setElapsed] = useState(0);
  const doneRef = useRef(onDone);
  useEffect(() => {
    doneRef.current = onDone;
  });

  useEffect(() => {
    const startedAt = Date.now();
    const timer = setInterval(() => {
      const seconds = Math.floor((Date.now() - startedAt) / 1_000);
      setElapsed(seconds);
      if (seconds >= SETTLE_IN_SECONDS) {
        clearInterval(timer);
        doneRef.current();
      }
    }, 200);
    return () => {
      clearInterval(timer);
    };
  }, []);

  const inhaling = elapsed % BREATH_SECONDS < BREATH_SECONDS / 2;
  const left = Math.max(0, SETTLE_IN_SECONDS - elapsed);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Settle in"
      className="fixed inset-0 z-[100] flex flex-col items-center justify-center gap-8 bg-[#05070a] px-4 text-center text-white"
    >
      <p className="text-xs tracking-[0.35em] text-white/40 uppercase">Settle in</p>
      <div
        aria-hidden="true"
        className="rounded-full bg-white/10 ring-1 ring-white/20"
        style={{
          width: inhaling ? '14rem' : '7rem',
          height: inhaling ? '14rem' : '7rem',
          transition: `width ${String(BREATH_SECONDS / 2)}s ease-in-out, height ${String(BREATH_SECONDS / 2)}s ease-in-out`,
        }}
      />
      <p role="status" className="font-display text-3xl">
        {inhaling ? 'Breathe in…' : 'Breathe out…'}
      </p>
      <p className="text-sm text-white/50">{`Deep Focus starts in ${String(left)} s`}</p>
      <div className="flex gap-3">
        <button
          type="button"
          onClick={onDone}
          className="rounded-full bg-white px-6 py-2.5 text-sm font-medium text-black hover:bg-white/90"
        >
          Start now
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-full border border-white/20 px-5 py-2.5 text-sm text-white/80 hover:bg-white/10"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
