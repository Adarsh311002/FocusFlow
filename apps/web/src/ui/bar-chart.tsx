import { motion } from 'motion/react';
import { useState } from 'react';

export interface BarDatum {
  readonly key: string;
  readonly label: string;
  /** The emphasised value (e.g. completed focus seconds). */
  readonly value: number;
  /** An optional larger total drawn behind the main bar (e.g. incl. abandoned). */
  readonly total?: number;
}

interface BarChartProps {
  readonly data: readonly BarDatum[];
  readonly formatValue: (value: number) => string;
  readonly height?: number;
  /** A horizontal goal line, in the same unit as the values. */
  readonly goal?: number;
}

/**
 * Animated vertical bars with a hover read-out. The numbers also exist as text elsewhere
 * (the day table), so the chart itself is decorative to assistive technology.
 */
export function BarChart({ data, formatValue, height = 180, goal }: BarChartProps) {
  const [hovered, setHovered] = useState<string | null>(null);
  const max = Math.max(1, goal ?? 0, ...data.map((item) => Math.max(item.value, item.total ?? 0)));
  const active = data.find((item) => item.key === hovered);

  return (
    <div aria-hidden="true" className="space-y-2">
      <div className="h-5 text-xs text-muted">
        {active === undefined
          ? 'Hover a day for details'
          : `${active.label}: ${formatValue(active.value)}${
              active.total !== undefined && active.total !== active.value
                ? ` · ${formatValue(active.total)} incl. stopped`
                : ''
            }`}
      </div>
      <div className="relative flex items-end gap-2" style={{ height }}>
        {goal !== undefined && (
          <div
            className="pointer-events-none absolute right-0 left-0 border-t border-dashed border-warm/60"
            style={{ bottom: `${String((goal / max) * 100)}%` }}
          >
            <span className="absolute -top-5 right-0 text-[10px] text-warm">
              {`Goal ${formatValue(goal)}`}
            </span>
          </div>
        )}
        {data.map((item, index) => (
          <div
            key={item.key}
            className="relative flex h-full flex-1 items-end"
            onMouseEnter={() => {
              setHovered(item.key);
            }}
            onMouseLeave={() => {
              setHovered(null);
            }}
          >
            {item.total !== undefined && (
              <motion.div
                className="absolute inset-x-0 bottom-0 rounded-t-lg bg-violet/20"
                initial={{ height: 0 }}
                animate={{ height: `${String((item.total / max) * 100)}%` }}
                transition={{ duration: 0.7, delay: index * 0.05, ease: 'easeOut' }}
              />
            )}
            <motion.div
              className="relative w-full rounded-t-lg bg-gradient-to-t from-focus/60 to-focus shadow-glow"
              initial={{ height: 0 }}
              animate={{ height: `${String((item.value / max) * 100)}%` }}
              whileHover={{ filter: 'brightness(1.25)' }}
              transition={{ duration: 0.7, delay: index * 0.05, ease: 'easeOut' }}
              style={{ minHeight: item.value > 0 ? 4 : 0 }}
            />
          </div>
        ))}
      </div>
      <div className="flex gap-2">
        {data.map((item) => (
          <div key={item.key} className="flex-1 text-center text-[11px] text-muted">
            {item.label}
          </div>
        ))}
      </div>
    </div>
  );
}
