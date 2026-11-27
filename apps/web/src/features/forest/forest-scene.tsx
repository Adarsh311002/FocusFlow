import type { ForestCreature, ForestPlant } from '@focus-flow/contracts';
import { motion } from 'motion/react';

import { CREATURE } from './forest-data';

// The forest drawn (GF6): every plant has a stable place, seeded by the id of the session it
// grew from, so the forest only ever gains plants and never reshuffles. Three depth rows give
// it room; vitality (GF4) sets the light and the fireflies. Decorative: the page states the
// same facts in text.

const W = 1200;
const H = 460;
const ROWS = [
  { baseline: 300, scale: 0.55, shade: 0.55 },
  { baseline: 360, scale: 0.75, shade: 0.75 },
  { baseline: 430, scale: 1, shade: 1 },
] as const;

/** A small, stable hash of a string (FNV-1a). */
function hashOf(text: string): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

function Plant({ plant }: { readonly plant: ForestPlant }) {
  const seed = hashOf(plant.id);
  const row = ROWS[seed % 3] ?? ROWS[2];
  const x = 40 + ((seed >>> 3) % 1000) * ((W - 80) / 1000);
  const lean = (((seed >>> 13) % 13) - 6) * 0.6;
  const green = ['#3f7a4a', '#4f8f52', '#2f6b45', '#5c9a5a'][(seed >>> 7) % 4] ?? '#3f7a4a';
  return (
    <g
      transform={`translate(${String(x)} ${String(row.baseline)}) scale(${String(row.scale)}) rotate(${String(lean)})`}
      opacity={row.shade}
    >
      {plant.kind === 'sprout' && (
        <>
          <path d="M0 0 Q1 -18 0 -30" stroke="#5c7a3f" strokeWidth="3" fill="none" />
          <ellipse cx="-9" cy="-28" rx="10" ry="5" fill={green} transform="rotate(-30 -9 -28)" />
          <ellipse cx="9" cy="-32" rx="10" ry="5" fill={green} transform="rotate(30 9 -32)" />
        </>
      )}
      {plant.kind === 'sapling' && (
        <>
          <path d="M0 0 Q3 -35 0 -70" stroke="#6b5233" strokeWidth="5" fill="none" />
          <circle cx="-14" cy="-62" r="16" fill={green} />
          <circle cx="14" cy="-68" r="17" fill={green} />
          <circle cx="0" cy="-84" r="18" fill={green} />
        </>
      )}
      {plant.kind === 'tree' && (
        <>
          <path d="M-7 0 L-5 -110 L5 -110 L7 0 Z" fill="#5b4126" />
          <circle cx="-30" cy="-118" r="32" fill={green} />
          <circle cx="30" cy="-124" r="34" fill={green} />
          <circle cx="0" cy="-152" r="38" fill={green} />
          <circle cx="-8" cy="-130" r="26" fill="#ffffff" opacity="0.06" />
        </>
      )}
      {plant.bloom && (
        <g fill="var(--ff-focus)">
          <circle
            cx={plant.kind === 'tree' ? -18 : -6}
            cy={plant.kind === 'tree' ? -140 : -40}
            r="4"
          />
          <circle
            cx={plant.kind === 'tree' ? 22 : 7}
            cy={plant.kind === 'tree' ? -110 : -52}
            r="3.5"
          />
          <circle
            cx={plant.kind === 'tree' ? 4 : 0}
            cy={plant.kind === 'tree' ? -168 : -60}
            r="3"
          />
        </g>
      )}
      {plant.glow && (
        <motion.circle
          cx="18"
          cy={plant.kind === 'tree' ? -180 : -70}
          r="4"
          fill="#e9f5a0"
          animate={{
            opacity: [0.2, 1, 0.2],
            cy: plant.kind === 'tree' ? [-180, -190, -180] : [-70, -80, -70],
          }}
          transition={{ duration: 3 + (seed % 3), repeat: Infinity, ease: 'easeInOut' }}
        />
      )}
    </g>
  );
}

/** Where each creature settles once its milestone is reached. */
const PERCH: Readonly<Record<ForestCreature, { x: number; y: number }>> = {
  firefly: { x: 8, y: 30 },
  frog: { x: 14, y: 88 },
  butterfly: { x: 32, y: 34 },
  toucan: { x: 52, y: 22 },
  owl: { x: 72, y: 26 },
  sloth: { x: 86, y: 18 },
  monkey: { x: 64, y: 12 },
  jaguar: { x: 82, y: 86 },
};

export function ForestScene({
  plants,
  creatures,
  vitality,
}: {
  readonly plants: readonly ForestPlant[];
  readonly creatures: readonly ForestCreature[];
  readonly vitality: number;
}) {
  return (
    <div
      aria-hidden="true"
      className="relative overflow-hidden rounded-[2rem] border border-line"
      style={{
        background: `linear-gradient(180deg, color-mix(in srgb, var(--ff-canvas-2) ${String(70 - vitality * 30)}%, #2d5a3d) 0%, var(--ff-canvas) 100%)`,
      }}
    >
      <svg viewBox={`0 0 ${String(W)} ${String(H)}`} className="block w-full">
        <defs>
          <radialGradient id="forest-light" cx="0.7" cy="0" r="0.8">
            <stop offset="0%" stopColor="#f6e7b0" stopOpacity={0.15 + vitality * 0.35} />
            <stop offset="100%" stopColor="#f6e7b0" stopOpacity="0" />
          </radialGradient>
        </defs>
        <rect width={W} height={H} fill="url(#forest-light)" />
        <path
          d={`M0 300 Q300 270 600 295 T1200 285 V${String(H)} H0 Z`}
          fill="#16301f"
          opacity="0.7"
        />
        <path
          d={`M0 360 Q300 335 600 358 T1200 350 V${String(H)} H0 Z`}
          fill="#122818"
          opacity="0.85"
        />
        <path d={`M0 430 Q300 412 600 428 T1200 422 V${String(H)} H0 Z`} fill="#0d1f13" />
        {plants.map((plant) => (
          <Plant key={plant.id} plant={plant} />
        ))}
        {Array.from({ length: Math.round(vitality * 14) }, (_, index) => (
          <motion.circle
            key={index}
            cx={(index * 97) % W}
            cy={120 + ((index * 53) % 200)}
            r="2.5"
            fill="#e9f5a0"
            animate={{ opacity: [0, 0.9, 0], x: [0, 12, 0] }}
            transition={{ duration: 4 + (index % 4), repeat: Infinity, delay: index * 0.4 }}
          />
        ))}
      </svg>
      {creatures.map((creature, index) => (
        <motion.span
          key={creature}
          className="absolute text-3xl md:text-4xl"
          style={{ left: `${String(PERCH[creature].x)}%`, top: `${String(PERCH[creature].y)}%` }}
          animate={{ y: [0, -6, 0] }}
          transition={{ duration: 3 + index * 0.3, repeat: Infinity, ease: 'easeInOut' }}
        >
          {CREATURE[creature].emoji}
        </motion.span>
      ))}
    </div>
  );
}
