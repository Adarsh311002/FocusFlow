import { AnimatePresence, motion, useAnimationControls } from 'motion/react';
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';

import { canDecorate } from './can-decorate';
import { type Critter as CritterKind, isForestOn, playCritter } from './soundscape';

/* Clickable jungle animals. Each says something useful about Focus Flow, cycling through
   its lines on every click, and makes its own sound. Until it has been tapped once it wears
   a pulsing badge, and every few seconds one animal on screen fidgets and calls out, so
   visitors discover that the animals have something to say. */

const LINES: Record<CritterKind, readonly string[]> = {
  monkey: [
    'Ooh-ooh! Stop swinging between tabs. Pick ONE task, then press start.',
    'Psst… your current task sits at the top of your dashboard. That’s the one.',
    'Even monkeys rest. Rooms have short and long breaks built in.',
  ],
  sloth: [
    'Slow is smooth. Your session keeps running on the server, even if your laptop naps.',
    'Lost your Wi-Fi? Relax. You get 60 seconds to come back before anything is lost.',
    'Pausing is fine. A paused session simply waits for you.',
  ],
  toucan: [
    'We flock together! Join a room and focus side by side.',
    'Share a six-letter code with friends, or keep your room private.',
    'Just perching here isn’t focusing. You opt in to each run.',
  ],
  frog: [
    'Ribbit. Every day you focus grows your streak.',
    'Hop back tomorrow and the streak keeps going.',
    'Set a daily goal and watch the ring fill up.',
  ],
  owl: [
    'Hoo knows when you think best? Your focus heatmap does.',
    'Review shows every session: what you worked on, and for how long.',
    'A wise habit: look back over your week every Sunday.',
  ],
  butterfly: [
    'Breathe in for four… and out for four.',
    'Small sessions add up. Even 15 minutes counts.',
    'Let distractions flutter by.',
  ],
  jaguar: [
    'You found me. Most people never look up from their screens long enough.',
    'I hunt one thing at a time. You should too.',
    'Stillness first. Then the leap. That is how deep work feels.',
  ],
};

/** What each animal says when it calls for attention. */
const CALLS: Record<CritterKind, string> = {
  monkey: 'Ooh-ooh! Over here!',
  sloth: '…psst… tap me…',
  toucan: 'Kreek! I know things',
  frog: 'Ribbit? Tap me',
  owl: 'Hoo? Ask me',
  butterfly: 'Follow me…',
  jaguar: 'I see you',
};

const NAMES: Record<CritterKind, string> = {
  monkey: 'Monkey',
  sloth: 'Sloth',
  toucan: 'Toucan',
  frog: 'Frog',
  owl: 'Owl',
  butterfly: 'Morpho butterfly',
  jaguar: 'Jaguar',
};

const MET_KEY = 'ff-critters-met';

function readMet(): Set<string> {
  try {
    return new Set((window.sessionStorage.getItem(MET_KEY) ?? '').split(',').filter(Boolean));
  } catch {
    return new Set();
  }
}

function rememberMet(kind: CritterKind): void {
  try {
    const met = readMet();
    met.add(kind);
    window.sessionStorage.setItem(MET_KEY, [...met].join(','));
  } catch {
    // Only means the badge shows again next visit.
  }
}

/* A tiny registry, so one animal on screen at a time can call for attention. */
const registry = new Map<string, { element: HTMLElement; call: () => void }>();
const metListeners = new Set<() => void>();

function notifyMet(): void {
  for (const listener of metListeners) {
    listener();
  }
}

/** Every few seconds, one animal that is on screen fidgets and calls out. */
function JungleAttentionInner() {
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const tick = (): void => {
      const visible = [...registry.values()].filter(({ element }) => {
        const box = element.getBoundingClientRect();
        return box.bottom > 60 && box.top < window.innerHeight - 60 && box.width > 0;
      });
      const pick = visible[Math.floor(Math.random() * visible.length)];
      pick?.call();
      timer = setTimeout(tick, 6500 + Math.random() * 4000);
    };
    timer = setTimeout(tick, 4500);
    return () => {
      clearTimeout(timer);
    };
  }, []);
  return null;
}

/** A one-time nudge: the animals have something to say. */
function JungleHintInner() {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const show = setTimeout(() => {
      if (readMet().size === 0) {
        setVisible(true);
      }
    }, 5000);
    const onMet = (): void => {
      setVisible(false);
    };
    metListeners.add(onMet);
    return () => {
      clearTimeout(show);
      metListeners.delete(onMet);
    };
  }, []);
  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          role="status"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 10 }}
          className="fixed bottom-20 left-5 z-50 flex max-w-xs items-start gap-3 rounded-2xl border border-[#c9a24a]/30 bg-[#07110c]/90 px-4 py-3 text-sm text-[#d5dbcc] shadow-[0_20px_60px_rgb(0_0_0_/_0.5)] backdrop-blur-xl"
        >
          <span aria-hidden="true" className="text-lg">
            🐾
          </span>
          <span>
            The animals here know things.{' '}
            <strong className="font-medium text-[#e0c47a]">Tap one</strong> and listen.
          </span>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => {
              setVisible(false);
            }}
            className="ml-1 text-[#8fa08a] hover:text-[#d5dbcc]"
          >
            ×
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

interface CritterProps {
  readonly kind: CritterKind;
  readonly className?: string;
  /** Where the speech bubble opens, relative to the animal. */
  readonly bubble?: 'left' | 'right' | 'below' | 'above';
  readonly children: ReactNode;
}

const BUBBLE_POSITION = {
  left: 'right-full top-1/4 mr-3',
  right: 'left-full top-1/4 ml-3',
  below: 'top-full left-1/2 mt-3 -translate-x-1/2',
  above: 'bottom-full left-1/2 mb-3 -translate-x-1/2',
} as const;

/** A clickable animal with a speech bubble, a "new" badge and an attention call. */
function CritterInner({ kind, className = '', bubble = 'left', children }: CritterProps) {
  const [line, setLine] = useState<number | null>(null);
  const [nudge, setNudge] = useState(0);
  const [calling, setCalling] = useState(false);
  const [met, setMet] = useState(() => readMet().has(kind));
  const wrapper = useRef<HTMLDivElement>(null);
  const controls = useAnimationControls();
  const id = useId();

  useEffect(() => {
    const element = wrapper.current;
    if (element === null) {
      return undefined;
    }
    registry.set(id, {
      element,
      call: () => {
        setCalling(true);
        void controls.start({
          rotate: [0, -10, 9, -7, 6, 0],
          y: [0, -10, 0, -6, 0],
          transition: { duration: 1.1, ease: 'easeInOut' },
        });
        if (isForestOn()) {
          playCritter(kind, 0.35);
        }
        setTimeout(() => {
          setCalling(false);
        }, 2800);
      },
    });
    return () => {
      registry.delete(id);
    };
  }, [id, kind, controls]);

  useEffect(() => {
    if (line === null) {
      return undefined;
    }
    const timer = setTimeout(() => {
      setLine(null);
    }, 7500);
    return () => {
      clearTimeout(timer);
    };
  }, [line, nudge]);

  const lines = LINES[kind];
  const text = line === null ? null : lines[line];

  return (
    <div ref={wrapper} className={`absolute z-40 ${className}`}>
      <motion.button
        type="button"
        aria-label={`${NAMES[kind]}: tap for a tip`}
        animate={controls}
        className="group relative block cursor-pointer rounded-full focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#e0c47a]"
        whileHover={{ scale: 1.07, rotate: -3 }}
        whileTap={{ scale: 0.92, rotate: 4 }}
        onClick={() => {
          playCritter(kind);
          setCalling(false);
          setLine((current) => (current === null ? 0 : (current + 1) % lines.length));
          setNudge((value) => value + 1);
          if (!met) {
            setMet(true);
            rememberMet(kind);
            notifyMet();
          }
        }}
      >
        {children}
        {!met && (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute -top-1 -right-1 grid h-6 w-6 place-items-center"
          >
            <span className="absolute inset-0 animate-ping rounded-full bg-[#e0c47a]/60" />
            <span className="relative grid h-5 w-5 place-items-center rounded-full bg-[#e0c47a] text-[11px] font-bold text-[#07110c]">
              ?
            </span>
          </span>
        )}
        <span
          aria-hidden="true"
          className="pointer-events-none absolute -bottom-7 left-1/2 -translate-x-1/2 rounded-full bg-[#07110c]/80 px-2 py-0.5 text-[10px] tracking-wider whitespace-nowrap text-[#d5dbcc] opacity-0 transition group-hover:opacity-100"
        >
          Tap me
        </span>
      </motion.button>

      <AnimatePresence>
        {calling && text === null && (
          <motion.div
            aria-hidden="true"
            initial={{ opacity: 0, scale: 0.6, y: 6 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.8 }}
            transition={{ type: 'spring', stiffness: 380, damping: 18 }}
            className={`pointer-events-none absolute rounded-full bg-[#e0c47a] px-3 py-1.5 text-xs font-medium whitespace-nowrap text-[#07110c] shadow-[0_8px_30px_rgb(224_196_122_/_0.4)] ${BUBBLE_POSITION[bubble]}`}
          >
            {CALLS[kind]}
          </motion.div>
        )}
        {text !== null && text !== undefined && (
          <motion.div
            key={`${String(line)}-${String(nudge)}`}
            role="status"
            initial={{ opacity: 0, scale: 0.8, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.9 }}
            transition={{ type: 'spring', stiffness: 320, damping: 22 }}
            className={`absolute w-64 rounded-3xl border border-[#c9a24a]/30 bg-[#e4e6d8] px-5 py-4 text-sm leading-relaxed text-[#0f1f16] shadow-[0_20px_50px_rgb(0_0_0_/_0.5)] ${BUBBLE_POSITION[bubble]}`}
          >
            <span className="mb-1 block text-[10px] tracking-[0.25em] text-[#3d5a3a] uppercase">
              {NAMES[kind]}
            </span>
            {text}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** Two glowing eyes in the undergrowth that blink and follow the cursor. */
export function EyesArt() {
  const eyes = useRef<SVGGElement>(null);
  useEffect(() => {
    const onMove = (event: PointerEvent): void => {
      const group = eyes.current;
      if (group === null) {
        return;
      }
      const box = group.getBoundingClientRect();
      const dx = event.clientX - (box.left + box.width / 2);
      const dy = event.clientY - (box.top + box.height / 2);
      const distance = Math.max(1, Math.hypot(dx, dy));
      group.style.transform = `translate(${String((dx / distance) * 3)}px, ${String((dy / distance) * 2)}px)`;
    };
    window.addEventListener('pointermove', onMove);
    return () => {
      window.removeEventListener('pointermove', onMove);
    };
  }, []);
  return (
    <svg width="110" height="70" viewBox="-55 -35 110 70" className="overflow-visible">
      {/* Leaves the eyes peer out from. */}
      <path d="M-55 30 C -40 -10, -20 -30, -6 -34 C -16 -10, -20 12, -55 30 Z" fill="#0d1f15" />
      <path d="M55 30 C 40 -12, 22 -30, 8 -34 C 16 -10, 22 12, 55 30 Z" fill="#14301f" />
      <path d="M-50 35 C -20 4, 20 4, 50 35 Z" fill="#0d1f15" />
      <g className="ff-eye-glow">
        <ellipse cx="-16" cy="-4" rx="10" ry="6" fill="#d8c25a" opacity="0.95" />
        <ellipse cx="16" cy="-4" rx="10" ry="6" fill="#d8c25a" opacity="0.95" />
        <g ref={eyes} style={{ transition: 'transform 0.3s ease-out' }}>
          <ellipse cx="-16" cy="-4" rx="2" ry="5.5" fill="#0a0a07" />
          <ellipse cx="16" cy="-4" rx="2" ry="5.5" fill="#0a0a07" />
        </g>
        <rect className="ff-lid" x="-28" y="-11" width="56" height="14" fill="#0d1f15" />
      </g>
    </svg>
  );
}

/* ------------------------------------------------------------------ the animals */

/** A monkey hanging by one arm from a vine, swinging gently. */
export function MonkeyArt({ vine = 120 }: { readonly vine?: number }) {
  const top = -vine;
  return (
    <svg
      width="120"
      height={160 + vine}
      viewBox={`-60 ${String(top)} 120 ${String(160 + vine)}`}
      className="ff-swing overflow-visible"
      style={{ transformOrigin: `50% 0%` }}
    >
      <path
        d={`M-4 ${String(top)} C 6 ${String(top / 2)}, -10 -30, -2 -4`}
        stroke="#2f6e45"
        strokeWidth="3"
        fill="none"
      />
      {/* arm up to the vine */}
      <path
        d="M-2 -4 C 0 10, 6 22, 8 34"
        stroke="#241911"
        strokeWidth="9"
        strokeLinecap="round"
        fill="none"
      />
      <circle cx="-2" cy="-4" r="6" fill="#3a2a1e" />
      {/* tail */}
      <path
        d="M-4 96 C -40 110, -48 70, -26 66 C -14 64, -16 80, -24 78"
        stroke="#241911"
        strokeWidth="5"
        strokeLinecap="round"
        fill="none"
      />
      {/* body */}
      <ellipse cx="4" cy="74" rx="22" ry="28" fill="#2f2219" />
      <ellipse cx="6" cy="80" rx="13" ry="17" fill="#8c7258" />
      {/* other arm and legs */}
      <path
        d="M-14 62 C -26 74, -24 88, -14 94"
        stroke="#241911"
        strokeWidth="8"
        strokeLinecap="round"
        fill="none"
      />
      <path
        d="M-6 98 C -10 112, -6 122, 0 126"
        stroke="#241911"
        strokeWidth="8"
        strokeLinecap="round"
        fill="none"
      />
      <path
        d="M14 98 C 20 110, 18 122, 12 128"
        stroke="#241911"
        strokeWidth="8"
        strokeLinecap="round"
        fill="none"
      />
      {/* head */}
      <circle cx="-16" cy="38" r="9" fill="#8c7258" />
      <circle cx="28" cy="38" r="9" fill="#8c7258" />
      <circle cx="6" cy="36" r="21" fill="#2f2219" />
      <ellipse cx="6" cy="42" rx="15" ry="13" fill="#cbb79a" />
      <circle cx="0" cy="34" r="3" fill="#1b120b" />
      <circle cx="13" cy="34" r="3" fill="#1b120b" />
      <circle cx="1" cy="33" r="1" fill="#fff" />
      <circle cx="14" cy="33" r="1" fill="#fff" />
      <path
        d="M0 47 Q 6 52 12 47"
        stroke="#1b120b"
        strokeWidth="2"
        strokeLinecap="round"
        fill="none"
      />
      <circle cx="4" cy="42" r="1.2" fill="#1b120b" />
      <circle cx="9" cy="42" r="1.2" fill="#1b120b" />
    </svg>
  );
}

/** A sloth hanging upside down from a branch, breathing slowly. */
export function SlothArt() {
  return (
    <svg width="200" height="150" viewBox="-100 -20 200 150" className="overflow-visible">
      <path
        d="M-100 0 C -40 -8, 40 8, 100 -4"
        stroke="#4a3220"
        strokeWidth="10"
        strokeLinecap="round"
        fill="none"
      />
      <path d="M60 -2 C 70 -16, 84 -14, 90 -22" stroke="#2f6e45" strokeWidth="3" fill="none" />
      <g className="ff-breathe-slow" style={{ transformOrigin: '0px 20px' }}>
        {/* arms hooked over the branch */}
        <path
          d="M-40 2 C -42 20, -30 40, -20 50"
          stroke="#5d5446"
          strokeWidth="12"
          strokeLinecap="round"
          fill="none"
        />
        <path
          d="M40 2 C 42 20, 30 40, 20 50"
          stroke="#5d5446"
          strokeWidth="12"
          strokeLinecap="round"
          fill="none"
        />
        <path
          d="M-44 -2 l -4 -6 M-40 -3 l 0 -7 M-36 -2 l 4 -6"
          stroke="#3a2a1c"
          strokeWidth="2"
          strokeLinecap="round"
        />
        <path
          d="M44 -2 l 4 -6 M40 -3 l 0 -7 M36 -2 l -4 -6"
          stroke="#3a2a1c"
          strokeWidth="2"
          strokeLinecap="round"
        />
        <ellipse cx="0" cy="56" rx="34" ry="24" fill="#6f6556" />
        {/* face, upside down below the body */}
        <circle cx="0" cy="88" r="22" fill="#6f6556" />
        <ellipse cx="0" cy="90" rx="17" ry="14" fill="#c9c0a8" />
        <ellipse cx="-8" cy="86" rx="7" ry="4.5" fill="#4a3424" transform="rotate(-18 -8 86)" />
        <ellipse cx="8" cy="86" rx="7" ry="4.5" fill="#4a3424" transform="rotate(18 8 86)" />
        <path
          d="M-10 86 q 2 2 4 0 M6 86 q 2 2 4 0"
          stroke="#c9c0a8"
          strokeWidth="1.4"
          fill="none"
        />
        <ellipse cx="0" cy="94" rx="3" ry="2" fill="#2a1d12" />
        <path
          d="M-5 99 Q 0 96 5 99"
          stroke="#2a1d12"
          strokeWidth="1.6"
          strokeLinecap="round"
          fill="none"
        />
      </g>
    </svg>
  );
}

/** A toucan on a branch, bobbing its head. */
export function ToucanArt({ flip = false }: { readonly flip?: boolean }) {
  return (
    <svg
      width="130"
      height="130"
      viewBox="-65 -70 130 130"
      className="overflow-visible"
      style={{ transform: flip ? 'scaleX(-1)' : undefined }}
    >
      <path
        d="M-65 46 C -20 40, 20 50, 65 44"
        stroke="#4a3220"
        strokeWidth="7"
        strokeLinecap="round"
        fill="none"
      />
      <path d="M-14 30 L -24 60 L -6 56 Z" fill="#141414" />
      <ellipse cx="0" cy="14" rx="20" ry="30" fill="#151515" />
      <path d="M-6 44 l -2 6 M2 44 l 2 6" stroke="#e8a33a" strokeWidth="3" strokeLinecap="round" />
      <g className="ff-bob" style={{ transformOrigin: '0px 0px' }}>
        <circle cx="4" cy="-16" r="16" fill="#151515" />
        <ellipse cx="6" cy="-4" rx="11" ry="12" fill="#f5e9c8" />
        <circle cx="10" cy="-20" r="5" fill="#7fd1c3" />
        <circle cx="11" cy="-20" r="2.2" fill="#111" />
        <path d="M16 -24 C 40 -30, 62 -18, 64 -8 C 50 -6, 30 -8, 16 -10 Z" fill="#f29d38" />
        <path d="M16 -10 C 30 -8, 50 -6, 64 -8 C 58 0, 36 2, 16 -4 Z" fill="#e7c34a" />
        <path d="M58 -14 C 62 -12, 64 -10, 64 -8 C 62 -7, 60 -8, 58 -9 Z" fill="#c2402e" />
      </g>
    </svg>
  );
}

/** A tree frog on a big leaf, its throat puffing. */
export function FrogArt() {
  return (
    <svg width="150" height="110" viewBox="-75 -60 150 110" className="overflow-visible">
      <path d="M-75 40 C -40 10, 40 10, 75 40 C 40 52, -40 52, -75 40 Z" fill="#2f6e45" />
      <path
        d="M-70 40 C -20 30, 20 30, 70 40"
        stroke="rgb(255 255 255 / 0.2)"
        strokeWidth="2"
        fill="none"
      />
      <ellipse cx="0" cy="14" rx="30" ry="20" fill="#3f8a3a" />
      <ellipse
        className="ff-throat"
        cx="0"
        cy="24"
        rx="14"
        ry="8"
        fill="#b9c98a"
        style={{ transformOrigin: '0px 24px' }}
      />
      <path
        d="M-26 24 C -40 30, -44 36, -36 38 M26 24 C 40 30, 44 36, 36 38"
        stroke="#357a32"
        strokeWidth="6"
        strokeLinecap="round"
        fill="none"
      />
      <circle cx="-16" cy="-6" r="11" fill="#3f8a3a" />
      <circle cx="16" cy="-6" r="11" fill="#3f8a3a" />
      <circle cx="-16" cy="-7" r="7" fill="#d9472b" />
      <circle cx="16" cy="-7" r="7" fill="#d9472b" />
      <ellipse className="ff-blink" cx="-16" cy="-7" rx="2.2" ry="5" fill="#111" />
      <ellipse className="ff-blink" cx="16" cy="-7" rx="2.2" ry="5" fill="#111" />
      <path
        d="M-12 10 Q 0 16 12 10"
        stroke="#2c5a1f"
        strokeWidth="2"
        strokeLinecap="round"
        fill="none"
      />
    </svg>
  );
}

/** An owl on a branch, blinking slowly. */
export function OwlArt() {
  return (
    <svg width="120" height="140" viewBox="-60 -70 120 140" className="overflow-visible">
      <path
        d="M-60 52 C -20 46, 20 56, 60 50"
        stroke="#4a3220"
        strokeWidth="8"
        strokeLinecap="round"
        fill="none"
      />
      <path d="M-30 -40 L -22 -62 L -12 -42 Z M30 -40 L 22 -62 L 12 -42 Z" fill="#6b4a2c" />
      <ellipse cx="0" cy="6" rx="34" ry="46" fill="#7a5532" />
      <ellipse cx="0" cy="18" rx="22" ry="30" fill="#c9a47a" />
      <path
        d="M-10 10 l 4 4 l 4 -4 M2 10 l 4 4 l 4 -4 M-10 22 l 4 4 l 4 -4 M2 22 l 4 4 l 4 -4 M-4 34 l 4 4 l 4 -4"
        stroke="#8d6a45"
        strokeWidth="1.6"
        fill="none"
      />
      <circle cx="-14" cy="-22" r="14" fill="#efe1c0" />
      <circle cx="14" cy="-22" r="14" fill="#efe1c0" />
      <g className="ff-blink" style={{ transformOrigin: '0px -22px' }}>
        <circle cx="-14" cy="-22" r="8" fill="#e8a33a" />
        <circle cx="14" cy="-22" r="8" fill="#e8a33a" />
        <circle cx="-14" cy="-22" r="4" fill="#111" />
        <circle cx="14" cy="-22" r="4" fill="#111" />
      </g>
      <path d="M-4 -12 L 0 -4 L 4 -12 Z" fill="#e8a33a" />
      <path
        d="M-12 48 l -3 6 M-6 48 l 0 7 M6 48 l 0 7 M12 48 l 3 6"
        stroke="#e8a33a"
        strokeWidth="2.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** A butterfly with flapping wings, drifting on its own path. */
export function ButterflyArt({ hue = '#2f6fd6' }: { readonly hue?: string }) {
  return (
    <svg
      width="64"
      height="56"
      viewBox="-32 -28 64 56"
      className="ff-flutter-path overflow-visible"
    >
      <g className="ff-flap-left" style={{ transformOrigin: '0px 0px' }}>
        <path d="M0 0 C -10 -26, -34 -26, -28 -4 C -26 6, -10 6, 0 0 Z" fill={hue} />
        <path d="M0 2 C -8 8, -22 22, -12 22 C -4 22, 0 12, 0 2 Z" fill={hue} opacity="0.8" />
        <circle cx="-17" cy="-10" r="4" fill="#1d1d1d" opacity="0.6" />
      </g>
      <g className="ff-flap-right" style={{ transformOrigin: '0px 0px' }}>
        <path d="M0 0 C 10 -26, 34 -26, 28 -4 C 26 6, 10 6, 0 0 Z" fill={hue} />
        <path d="M0 2 C 8 8, 22 22, 12 22 C 4 22, 0 12, 0 2 Z" fill={hue} opacity="0.8" />
        <circle cx="17" cy="-10" r="4" fill="#1d1d1d" opacity="0.6" />
      </g>
      <ellipse cx="0" cy="2" rx="2" ry="12" fill="#2a1d12" />
      <path
        d="M0 -10 C -2 -18, -6 -20, -8 -22 M0 -10 C 2 -18, 6 -20, 8 -22"
        stroke="#2a1d12"
        strokeWidth="1"
        fill="none"
      />
    </svg>
  );
}

/** Draws Critter only where decorations are wanted (see `canDecorate`). */
export function Critter(props: Parameters<typeof CritterInner>[0]) {
  return canDecorate() ? <CritterInner {...props} /> : null;
}

/** Draws JungleAttention only where decorations are wanted (see `canDecorate`). */
export function JungleAttention() {
  return canDecorate() ? <JungleAttentionInner /> : null;
}

/** Draws JungleHint only where decorations are wanted (see `canDecorate`). */
export function JungleHint() {
  return canDecorate() ? <JungleHintInner /> : null;
}
