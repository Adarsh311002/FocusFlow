import { type ReactNode, useId } from 'react';

interface ProgressRingProps {
  /** 0 to 1. */
  readonly progress: number;
  readonly size?: number;
  readonly stroke?: number;
  readonly children?: ReactNode;
  /** Dims and calms the ring, e.g. while paused. */
  readonly muted?: boolean;
}

/** A glowing circular progress ring with its content centred inside. Decorative only. */
export function ProgressRing({
  progress,
  size = 260,
  stroke = 12,
  children,
  muted = false,
}: ProgressRingProps) {
  const gradientId = useId();
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const clamped = Math.min(1, Math.max(0, progress));

  return (
    <div className="relative mx-auto" style={{ width: size, height: size }}>
      <svg
        aria-hidden="true"
        width={size}
        height={size}
        viewBox={`0 0 ${String(size)} ${String(size)}`}
        className="-rotate-90"
        style={{ filter: muted ? 'none' : 'drop-shadow(0 0 14px rgb(200 161 90 / 0.45))' }}
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="var(--ff-focus)" />
            <stop offset="100%" stopColor="var(--ff-violet)" />
          </linearGradient>
        </defs>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="var(--ff-line)"
          strokeWidth={stroke}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={`url(#${gradientId})`}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - clamped)}
          opacity={muted ? 0.5 : 1}
          style={{ transition: 'stroke-dashoffset 1s linear, opacity 0.4s' }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
        {children}
      </div>
    </div>
  );
}
