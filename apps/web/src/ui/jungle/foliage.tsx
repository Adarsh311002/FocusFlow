import { motion, useScroll, useTransform } from 'motion/react';

import { canDecorate } from './can-decorate';

/* Hand-drawn jungle foliage as inline SVG: no image downloads, crisp at any size, and
   every piece sways on its own slow rhythm. All of it is decorative. */

export const LEAF = {
  deep: '#0d1f15',
  dark: '#14301f',
  mid: '#1c3f28',
  bright: '#285234',
  light: '#356340',
  lime: '#4b7a45',
  vein: 'rgb(255 255 255 / 0.1)',
} as const;

/** A heart-shaped money-plant (pothos) leaf, pointing down from its stem at the origin. */
export function PothosLeaf({
  size = 40,
  color = LEAF.mid,
  rotate = 0,
  variegated = false,
}: {
  readonly size?: number;
  readonly color?: string;
  readonly rotate?: number;
  readonly variegated?: boolean;
}) {
  return (
    <g transform={`rotate(${String(rotate)}) scale(${String(size / 40)})`}>
      <path d="M0 0 C 2 4, 3 8, 3 10" stroke={LEAF.dark} strokeWidth="1.4" fill="none" />
      <path
        d="M3 10 C -14 8, -20 26, -6 40 C -2 44, 1 48, 3 52 C 5 48, 8 44, 12 40 C 26 26, 20 8, 3 10 Z"
        fill={color}
      />
      {variegated && (
        <path d="M3 14 C -6 18, -8 28, 1 38 C 2 30, 4 22, 3 14 Z" fill="rgb(232 240 200 / 0.35)" />
      )}
      <path d="M3 12 C 3 26, 3 38, 3 50" stroke={LEAF.vein} strokeWidth="1" fill="none" />
      <path
        d="M3 22 L -6 18 M3 22 L 12 18 M3 32 L -8 30 M3 32 L 14 30 M3 41 L -3 40 M3 41 L 9 40"
        stroke={LEAF.vein}
        strokeWidth="0.7"
        fill="none"
      />
    </g>
  );
}

/** A split monstera leaf, stem at the origin, opening upwards. */
export function MonsteraLeaf({ color = LEAF.dark }: { readonly color?: string }) {
  return (
    <g>
      <path d="M0 0 C 2 -30, 4 -50, 6 -70" stroke={LEAF.deep} strokeWidth="4" fill="none" />
      <path
        d="M6 -70 C -50 -70, -90 -120, -70 -170 C -50 -215, 20 -230, 60 -200 C 100 -170, 100 -110, 60 -80 C 40 -68, 20 -68, 6 -70 Z"
        fill={color}
      />
      {/* The splits and holes that make a monstera a monstera. */}
      <g fill="var(--jungle-gap, #0b1a13)">
        <path d="M-60 -110 L -20 -118 L -58 -125 Z" />
        <path d="M-66 -150 L -18 -140 L -60 -165 Z" />
        <path d="M-40 -195 L -8 -160 L -22 -205 Z" />
        <path d="M30 -210 L 16 -165 L 46 -200 Z" />
        <path d="M80 -170 L 28 -145 L 86 -150 Z" />
        <path d="M84 -115 L 30 -118 L 80 -100 Z" />
        <ellipse cx="-30" cy="-140" rx="5" ry="9" transform="rotate(-30 -30 -140)" />
        <ellipse cx="40" cy="-140" rx="5" ry="9" transform="rotate(30 40 -140)" />
      </g>
      <path
        d="M6 -70 C 8 -120, 4 -170, -4 -215"
        stroke="rgb(255 255 255 / 0.15)"
        strokeWidth="2"
        fill="none"
      />
    </g>
  );
}

/** A fern frond rising from the origin. */
export function Fern({
  color = LEAF.mid,
  length = 220,
  bend = 30,
}: {
  readonly color?: string;
  readonly length?: number;
  readonly bend?: number;
}) {
  const pairs = 14;
  return (
    <g>
      <path
        d={`M0 0 Q ${String(bend)} ${String(-length / 2)} ${String(bend * 1.6)} ${String(-length)}`}
        stroke={color}
        strokeWidth="2.5"
        fill="none"
      />
      {Array.from({ length: pairs }, (_, index) => {
        const t = (index + 1) / (pairs + 1);
        const x = bend * 1.6 * t * t + bend * 2 * t * (1 - t) * 0.5;
        const y = -length * t;
        const span = 34 * (1 - t * 0.75);
        return (
          <g key={index} transform={`translate(${String(x)} ${String(y)})`}>
            <path
              d={`M0 0 C ${String(-span * 0.4)} ${String(-span * 0.15)}, ${String(-span * 0.8)} ${String(-span * 0.2)}, ${String(-span)} ${String(-span * 0.45)} C ${String(-span * 0.7)} ${String(-span * 0.05)}, ${String(-span * 0.3)} ${String(span * 0.05)}, 0 0 Z`}
              fill={color}
            />
            <path
              d={`M0 0 C ${String(span * 0.4)} ${String(-span * 0.15)}, ${String(span * 0.8)} ${String(-span * 0.2)}, ${String(span)} ${String(-span * 0.45)} C ${String(span * 0.7)} ${String(-span * 0.05)}, ${String(span * 0.3)} ${String(span * 0.05)}, 0 0 Z`}
              fill={color}
            />
          </g>
        );
      })}
    </g>
  );
}

/** A long banana / palm leaf rising from the origin. */
export function BananaLeaf({
  color = LEAF.bright,
  length = 260,
}: {
  readonly color?: string;
  readonly length?: number;
}) {
  const l = String(length);
  const half = String(length / 2);
  return (
    <g>
      <path
        d={`M0 0 C -40 -${half}, -10 -${l}, 30 -${l} C 70 -${l}, 70 -${half}, 0 0 Z`}
        fill={color}
      />
      <path
        d={`M0 0 C 10 -${half}, 22 -${l}, 30 -${l}`}
        stroke="rgb(255 255 255 / 0.2)"
        strokeWidth="2"
        fill="none"
      />
      <path
        d={`M12 -${String(length * 0.3)} L -14 -${String(length * 0.42)} M18 -${String(length * 0.55)} L 52 -${String(length * 0.62)}`}
        stroke="var(--jungle-gap, #0b1a13)"
        strokeWidth="3"
      />
    </g>
  );
}

/** A long, narrow philodendron leaf hanging from its stem at the origin. */
export function LanceLeaf({
  size = 40,
  color = LEAF.mid,
  rotate = 0,
}: {
  readonly size?: number;
  readonly color?: string;
  readonly rotate?: number;
}) {
  return (
    <g transform={`rotate(${String(rotate)}) scale(${String(size / 40)})`}>
      <path d="M0 0 C 1 5, 1 9, 1 12" stroke={LEAF.deep} strokeWidth="1.6" fill="none" />
      <path
        d="M1 12 C -12 20, -12 46, 0 70 C 2 74, 3 74, 4 70 C 16 46, 14 20, 1 12 Z"
        fill={color}
      />
      <path d="M1 14 C 2 34, 2 52, 2 70" stroke={LEAF.vein} strokeWidth="0.9" fill="none" />
    </g>
  );
}

interface VineSpec {
  readonly x: number; // percent of width
  readonly length: number; // percent of viewport height
  readonly leaves: number;
  readonly thickness: number;
  readonly kind: 'liana' | 'aerial';
}

/** Deterministic vines: a dense curtain of lianas, thin aerial roots between them. */
const VINES: readonly VineSpec[] = Array.from({ length: 30 }, (_, index) => {
  const spread = (index * 37) % 100;
  const aerial = index % 3 === 2;
  return {
    x: spread + ((index * 13) % 7) * 0.3,
    length: aerial ? 30 + ((index * 29) % 40) : 14 + ((index * 41) % 46),
    leaves: aerial ? 0 : 3 + ((index * 7) % 7),
    thickness: aerial ? 1.2 : 2.6 + ((index * 11) % 4),
    kind: aerial ? 'aerial' : 'liana',
  };
});

const LEAF_COLORS = [LEAF.dark, LEAF.mid, LEAF.deep, LEAF.bright, LEAF.mid] as const;

function Vine({ spec, index }: { readonly spec: VineSpec; readonly index: number }) {
  const height = 1000;
  const drop = (spec.length / 100) * height;
  const wobble = 10 + (index % 5) * 4;
  const path = `M0 0 C ${String(wobble)} ${String(drop * 0.3)}, ${String(-wobble)} ${String(drop * 0.65)}, ${String(wobble / 3)} ${String(drop)}`;
  return (
    <div
      className="ff-sway absolute top-0"
      style={{
        left: `${String(spec.x)}%`,
        animationDelay: `${String(-(index % 7) * 1.3)}s`,
        animationDuration: `${String(9 + (index % 5) * 1.5)}s`,
        transformOrigin: 'top center',
      }}
    >
      <svg
        width="120"
        viewBox={`-60 0 120 ${String(height)}`}
        preserveAspectRatio="xMidYMin meet"
        className="h-screen overflow-visible"
      >
        <path
          d={path}
          stroke={spec.kind === 'aerial' ? '#2b2219' : '#1b2a1a'}
          strokeWidth={spec.thickness}
          strokeLinecap="round"
          fill="none"
          opacity={spec.kind === 'aerial' ? 0.75 : 1}
        />
        {spec.kind === 'liana' && (
          <>
            {/* Moss clinging to the liana. */}
            <path
              d={path}
              stroke="#2f4a2a"
              strokeWidth={spec.thickness + 3}
              strokeDasharray="6 38"
              strokeLinecap="round"
              fill="none"
              opacity="0.8"
            />
            {Array.from({ length: spec.leaves }, (_, leaf) => {
              const t = (leaf + 1) / (spec.leaves + 0.6);
              const y = drop * t;
              const side = leaf % 2 === 0 ? -1 : 1;
              const x = Math.sin(t * Math.PI * 1.3) * wobble * 0.4;
              return (
                <g key={leaf} transform={`translate(${String(x)} ${String(y)})`}>
                  <LanceLeaf
                    size={34 + ((leaf + index) % 4) * 8}
                    rotate={side * (24 + ((leaf + index) % 3) * 14)}
                    color={LEAF_COLORS[(leaf + index) % LEAF_COLORS.length] ?? LEAF.mid}
                  />
                </g>
              );
            })}
          </>
        )}
        {spec.kind === 'aerial' && (
          <path
            d={`M${String(wobble / 3)} ${String(drop)} l -3 18 M${String(wobble / 3)} ${String(drop)} l 4 14`}
            stroke="#2b2219"
            strokeWidth="1"
            fill="none"
            opacity="0.7"
          />
        )}
      </svg>
    </div>
  );
}

/** A dense curtain of lianas and aerial roots hanging from a heavy canopy along the top. */
/** 'app' hangs a shorter, sparser curtain so the vines never cover the work. */
function HangingCanopyInner({ variant = 'landing' }: { readonly variant?: 'landing' | 'app' }) {
  const vines =
    variant === 'app'
      ? VINES.filter((_, index) => index % 2 === 0).map((spec) => ({
          ...spec,
          length: Math.min(spec.length, spec.kind === 'aerial' ? 24 : 15),
          leaves: Math.min(spec.leaves, 4),
        }))
      : VINES;
  const { scrollY } = useScroll();
  const lift = useTransform(scrollY, [0, 900], [0, -260]);
  const fade = useTransform(scrollY, [0, 800], [1, 0.55]);
  return (
    <motion.div
      aria-hidden="true"
      style={{ y: lift, opacity: fade }}
      className="pointer-events-none fixed inset-x-0 top-0 z-30 h-0"
    >
      {vines.map((spec, index) => (
        <Vine key={index} spec={spec} index={index} />
      ))}
      {/* The canopy itself: overlapping dark leaves along the top edge. */}
      <svg
        className="absolute inset-x-0 -top-2 h-32 w-full"
        viewBox="0 0 1440 128"
        preserveAspectRatio="none"
      >
        <path
          d="M0 0 H1440 V58 C1400 92 1350 60 1300 84 C1240 112 1190 66 1130 80 C1060 98 1010 58 950 76 C880 100 830 62 760 82 C690 104 640 60 580 74 C510 92 460 58 400 80 C330 106 280 62 220 76 C150 94 100 60 50 82 C30 90 10 80 0 84 Z"
          fill={LEAF.deep}
        />
      </svg>
      <svg
        className="absolute inset-x-0 top-0 h-28 w-full"
        viewBox="0 0 1440 112"
        preserveAspectRatio="none"
      >
        {Array.from({ length: 34 }, (_, index) => (
          <g
            key={index}
            transform={`translate(${String((index * 1440) / 33)} ${String(30 + ((index * 17) % 30))}) rotate(${String(((index * 47) % 120) - 60)})`}
          >
            <LanceLeaf
              size={46 + ((index * 13) % 30)}
              color={LEAF_COLORS[index % LEAF_COLORS.length] ?? LEAF.dark}
            />
          </g>
        ))}
      </svg>
    </motion.div>
  );
}

/** Big leaves and ferns growing in from the bottom corners of a section. */
export function CornerFoliage({ side }: { readonly side: 'left' | 'right' }) {
  const flip = side === 'right' ? -1 : 1;
  return (
    <svg
      aria-hidden="true"
      viewBox="-160 -300 360 300"
      className={`pointer-events-none absolute bottom-0 h-[46vh] max-h-[460px] ${
        side === 'left' ? '-left-10' : '-right-10'
      }`}
      style={{ transform: `scaleX(${String(flip)})` }}
    >
      <g className="ff-sway-slow" style={{ transformOrigin: '0px 0px', transformBox: 'view-box' }}>
        <g transform="translate(-40 0) rotate(-28)">
          <BananaLeaf color={LEAF.dark} length={280} />
        </g>
        <g transform="translate(10 0) rotate(-6)">
          <MonsteraLeaf color={LEAF.mid} />
        </g>
        <g transform="translate(60 0) rotate(22)">
          <Fern color={LEAF.bright} length={200} bend={26} />
        </g>
        <g transform="translate(-80 0) rotate(-48)">
          <Fern color={LEAF.light} length={160} bend={-20} />
        </g>
      </g>
      {/* A low bush hugging the ground. */}
      <path
        d="M-160 0 C -150 -40, -110 -50, -90 -30 C -80 -60, -30 -64, -20 -34 C 0 -60, 50 -56, 56 -26 C 76 -44, 120 -36, 130 -10 L 140 0 Z"
        fill={LEAF.deep}
      />
    </svg>
  );
}

/** Slow drifting fireflies. */
export function Fireflies({ count = 22 }: { readonly count?: number }) {
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
      {Array.from({ length: count }, (_, index) => {
        const left = (index * 37) % 100;
        const top = (index * 53) % 100;
        return (
          <span
            key={index}
            className="ff-firefly absolute h-1.5 w-1.5 rounded-full bg-[#c9e07a]"
            style={{
              left: `${String(left)}%`,
              top: `${String(top)}%`,
              animationDelay: `${String(-(index % 9) * 1.3)}s`,
              animationDuration: `${String(9 + (index % 5) * 2)}s`,
            }}
          />
        );
      })}
    </div>
  );
}

/** Sunbeams slanting through the canopy. */
export function LightRays() {
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
      {[12, 30, 52, 70].map((left, index) => (
        <span
          key={left}
          className="ff-ray absolute -top-20 h-[130%] w-40 origin-top bg-gradient-to-b from-[#d8e6c0]/12 via-[#d8e6c0]/[0.03] to-transparent blur-xl"
          style={{
            left: `${String(left)}%`,
            transform: 'rotate(18deg)',
            animationDelay: `${String(-index * 2.5)}s`,
          }}
        />
      ))}
    </div>
  );
}

/** Dappled leaf shadows drifting over a light section (komorebi). */
export function DappledShade() {
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
      <svg
        className="ff-dapple absolute -inset-[10%] h-[120%] w-[120%] opacity-[0.09]"
        viewBox="0 0 800 600"
        preserveAspectRatio="xMidYMid slice"
      >
        <g fill="#163d2a" style={{ filter: 'blur(6px)' }}>
          <g transform="translate(80 40) rotate(20) scale(2.2)">
            <PothosLeaf color="#163d2a" size={60} />
          </g>
          <g transform="translate(620 20) rotate(-30) scale(1.4)">
            <MonsteraLeaf color="#163d2a" />
          </g>
          <g transform="translate(300 380) rotate(160) scale(2)">
            <PothosLeaf color="#163d2a" size={60} />
          </g>
          <g transform="translate(720 560) rotate(200) scale(1.1)">
            <MonsteraLeaf color="#163d2a" />
          </g>
          <g transform="translate(40 600) rotate(-10)">
            <Fern color="#163d2a" length={300} bend={60} />
          </g>
        </g>
      </svg>
    </div>
  );
}

interface RootStroke {
  readonly d: string;
  readonly width: number;
  readonly depth: number;
}

/** Grows gnarled roots (or branches) as tapering strokes, deterministically from a seed. */
function growRoots(
  seed: number,
  origins: readonly { x: number; y: number; angle: number }[],
  reach: number,
): RootStroke[] {
  let state = seed;
  const random = (): number => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
  const strokes: RootStroke[] = [];
  function root(
    x: number,
    y: number,
    angle: number,
    length: number,
    width: number,
    depth: number,
  ): void {
    let px = x;
    let py = y;
    let heading = angle;
    let d = `M${px.toFixed(1)} ${py.toFixed(1)}`;
    const steps = 6;
    for (let step = 0; step < steps; step += 1) {
      heading += (random() - 0.5) * 0.7;
      const nx = px + Math.cos(heading) * (length / steps);
      const ny = py + Math.sin(heading) * (length / steps);
      const cx = px + Math.cos(heading + (random() - 0.5)) * (length / steps) * 0.6;
      const cy = py + Math.sin(heading + (random() - 0.5)) * (length / steps) * 0.6;
      d += ` Q${cx.toFixed(1)} ${cy.toFixed(1)} ${nx.toFixed(1)} ${ny.toFixed(1)}`;
      px = nx;
      py = ny;
      if (depth < 3 && random() < 0.28) {
        root(
          px,
          py,
          heading + (random() < 0.5 ? -1 : 1) * (0.5 + random() * 0.6),
          length * 0.55,
          width * 0.55,
          depth + 1,
        );
      }
    }
    strokes.push({ d, width, depth });
  }
  for (const origin of origins) {
    root(origin.x, origin.y, origin.angle, reach, 16, 0);
  }
  return strokes.sort((a, b) => b.width - a.width);
}

const ROOT_LAYOUTS = {
  /** Roots crawling in along the bottom edge from both corners and the middle. */
  bottom: [
    { x: -20, y: 300, angle: -0.15 },
    { x: 1460, y: 300, angle: Math.PI + 0.12 },
    { x: 560, y: 320, angle: -0.6 },
    { x: 900, y: 320, angle: Math.PI + 0.55 },
  ],
  /** Branches reaching down and inwards from the top corners. */
  top: [
    { x: -20, y: -10, angle: 0.25 },
    { x: 1460, y: -10, angle: Math.PI - 0.3 },
    { x: 380, y: -20, angle: 1.1 },
    { x: 1100, y: -20, angle: 2.0 },
  ],
} as const;

/**
 * Gnarled roots or branches that draw themselves across a section edge when it scrolls
 * into view. Sits in a 1440 x 320 box stretched along the top or bottom of its parent.
 */
export function CreepingRoots({
  edge,
  seed = 11,
  color = '#3d2f22',
}: {
  readonly edge: 'top' | 'bottom';
  readonly seed?: number;
  readonly color?: string;
}) {
  const strokes = growRoots(seed, ROOT_LAYOUTS[edge], 620);
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 1440 320"
      preserveAspectRatio="none"
      className={`pointer-events-none absolute inset-x-0 z-10 h-[26vh] w-full ${
        edge === 'bottom' ? 'bottom-0' : 'top-0'
      }`}
    >
      {strokes.map((stroke, index) => (
        <motion.path
          key={index}
          d={stroke.d}
          stroke={color}
          strokeWidth={stroke.width}
          strokeLinecap="round"
          fill="none"
          initial={{ pathLength: 0 }}
          whileInView={{ pathLength: 1 }}
          viewport={{ once: true, margin: '-10% 0px' }}
          transition={{
            duration: 2.6 + stroke.depth * 0.5,
            delay: stroke.depth * 0.5,
            ease: 'easeOut',
          }}
        />
      ))}
      {/* A thin mossy highlight along the thickest roots. */}
      {strokes
        .filter((stroke) => stroke.depth === 0)
        .map((stroke, index) => (
          <motion.path
            key={`moss-${String(index)}`}
            d={stroke.d}
            stroke="#3a5232"
            strokeWidth={3}
            strokeDasharray="2 22"
            strokeLinecap="round"
            fill="none"
            initial={{ pathLength: 0 }}
            whileInView={{ pathLength: 1 }}
            viewport={{ once: true, margin: '-10% 0px' }}
            transition={{ duration: 3, delay: 0.6, ease: 'easeOut' }}
          />
        ))}
    </svg>
  );
}

/** Slow drifting layers of ground mist. */
export function Mist({ tone = 'light' }: { readonly tone?: 'light' | 'dark' }) {
  const color = tone === 'light' ? 'rgb(200 216 205 / 0.09)' : 'rgb(7 17 12 / 0.35)';
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
      {[0, 1, 2].map((layer) => (
        <div
          key={layer}
          className="ff-mist absolute h-[45%] w-[160%] rounded-[50%] blur-3xl"
          style={{
            background: `radial-gradient(ellipse at center, ${color}, transparent 70%)`,
            bottom: `${String(layer * 14 - 8)}%`,
            left: `${String(-30 - layer * 10)}%`,
            animationDuration: `${String(40 + layer * 18)}s`,
            animationDelay: `${String(-layer * 12)}s`,
          }}
        />
      ))}
    </div>
  );
}

/** Draws HangingCanopy only where decorations are wanted (see `canDecorate`). */
export function HangingCanopy(props: Parameters<typeof HangingCanopyInner>[0]) {
  return canDecorate() ? <HangingCanopyInner {...props} /> : null;
}
