import { motion } from 'motion/react';
import { useState } from 'react';

export interface StemDatum {
  readonly key: string;
  readonly label: string;
  /** Completed focus, drawn as the living stem. */
  readonly value: number;
  /** Everything focused, including stopped sessions, drawn as a faint taller ghost stem. */
  readonly total: number;
}

const WIDTH = 760;
const HEIGHT = 280;
const GROUND = 236;
const TOP = 34;
const EASE = [0.22, 1, 0.36, 1] as const;

/**
 * Each day grows as a plant: the stem's height is the day's completed focus, a leaf for
 * every stretch of it, and a glowing bud on top when there was any. Decorative: the same
 * numbers are in the table beside it.
 */
export function StemChart({
  data,
  formatValue,
}: {
  readonly data: readonly StemDatum[];
  readonly formatValue: (value: number) => string;
}) {
  const [hovered, setHovered] = useState<string | null>(null);
  const max = Math.max(1, ...data.map((item) => Math.max(item.value, item.total)));
  const step = WIDTH / data.length;
  const active = data.find((item) => item.key === hovered);

  return (
    <div aria-hidden="true" className="space-y-2">
      <p className="h-5 text-xs text-muted">
        {active === undefined
          ? 'Hover a day to read it'
          : `${active.label}: ${formatValue(active.value)} completed${
              active.total > active.value ? ` · ${formatValue(active.total)} in all` : ''
            }`}
      </p>
      <svg viewBox={`0 0 ${String(WIDTH)} ${String(HEIGHT)}`} className="w-full overflow-visible">
        {/* The forest floor. */}
        <path
          d={`M0 ${String(GROUND)} C ${String(WIDTH * 0.3)} ${String(GROUND - 6)}, ${String(WIDTH * 0.7)} ${String(GROUND + 6)}, ${String(WIDTH)} ${String(GROUND)}`}
          stroke="var(--ff-line)"
          strokeWidth="2"
          fill="none"
        />
        {data.map((item, index) => {
          const x = step * index + step / 2;
          const height = (item.value / max) * (GROUND - TOP);
          const ghost = (item.total / max) * (GROUND - TOP);
          const sway = (index % 2 === 0 ? 1 : -1) * Math.min(14, height * 0.08);
          const stem = `M${String(x)} ${String(GROUND)} C ${String(x + sway)} ${String(GROUND - height * 0.4)}, ${String(x - sway)} ${String(GROUND - height * 0.75)}, ${String(x)} ${String(GROUND - height)}`;
          const leaves = Math.max(0, Math.floor(height / 34));
          const isActive = hovered === item.key;
          return (
            <g
              key={item.key}
              onMouseEnter={() => {
                setHovered(item.key);
              }}
              onMouseLeave={() => {
                setHovered(null);
              }}
              className="cursor-default"
            >
              {/* A wide invisible target, so the whole column answers the pointer. */}
              <rect x={x - step / 2} y={0} width={step} height={HEIGHT} fill="transparent" />
              {ghost > height && (
                <motion.line
                  x1={x}
                  x2={x}
                  y1={GROUND}
                  y2={GROUND - ghost}
                  stroke="var(--ff-violet)"
                  strokeOpacity="0.35"
                  strokeWidth="2"
                  strokeDasharray="3 6"
                  initial={{ pathLength: 0 }}
                  animate={{ pathLength: 1 }}
                  transition={{ duration: 1.2, delay: index * 0.08, ease: EASE }}
                />
              )}
              {height > 0 ? (
                <>
                  <motion.path
                    d={stem}
                    stroke={isActive ? 'var(--ff-focus)' : 'var(--ff-ok)'}
                    strokeWidth="3.5"
                    strokeLinecap="round"
                    fill="none"
                    initial={{ pathLength: 0 }}
                    animate={{ pathLength: 1 }}
                    transition={{ duration: 1.4, delay: index * 0.08, ease: EASE }}
                  />
                  {Array.from({ length: leaves }, (_, leaf) => {
                    const y = GROUND - ((leaf + 1) / (leaves + 1)) * height;
                    const side = leaf % 2 === 0 ? 1 : -1;
                    return (
                      <motion.path
                        key={leaf}
                        d={`M${String(x)} ${String(y)} C ${String(x + side * 10)} ${String(y - 14)}, ${String(x + side * 26)} ${String(y - 10)}, ${String(x + side * 30)} ${String(y - 2)} C ${String(x + side * 22)} ${String(y + 4)}, ${String(x + side * 8)} ${String(y + 4)}, ${String(x)} ${String(y)} Z`}
                        fill="var(--ff-violet)"
                        initial={{ scale: 0, opacity: 0 }}
                        animate={{ scale: 1, opacity: 0.9 }}
                        style={{ transformOrigin: `${String(x)}px ${String(y)}px` }}
                        transition={{ duration: 0.6, delay: 0.5 + index * 0.08 + leaf * 0.06 }}
                      />
                    );
                  })}
                  <motion.circle
                    cx={x}
                    cy={GROUND - height}
                    r={isActive ? 9 : 7}
                    fill="var(--ff-focus)"
                    initial={{ scale: 0 }}
                    animate={{ scale: 1 }}
                    style={{
                      transformOrigin: `${String(x)}px ${String(GROUND - height)}px`,
                      filter: 'drop-shadow(0 0 10px rgb(201 162 74 / 0.6))',
                    }}
                    transition={{ duration: 0.5, delay: 1.1 + index * 0.08 }}
                  />
                </>
              ) : (
                // A seed in the ground on a day without completed focus.
                <ellipse
                  cx={x}
                  cy={GROUND + 2}
                  rx="5"
                  ry="3"
                  fill="var(--ff-muted)"
                  opacity="0.5"
                />
              )}
              <text
                x={x}
                y={GROUND + 30}
                textAnchor="middle"
                fontSize="12"
                fill={isActive ? 'var(--ff-ink)' : 'var(--ff-muted)'}
              >
                {item.label}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
