import {
  animate,
  AnimatePresence,
  motion,
  type MotionValue,
  useInView,
  useMotionValueEvent,
  useScroll,
  useTransform,
} from 'motion/react';
import { useEffect, useRef, useState } from 'react';

import { Critter, OwlArt, ToucanArt } from '../../ui/jungle/critters';
import { CreepingRoots, DappledShade, Fireflies, Mist } from '../../ui/jungle/foliage';

const EASE = [0.22, 1, 0.36, 1] as const;

/** Fades and lifts its children in once, when they scroll into view. */
export function Reveal({
  children,
  delay = 0,
  className,
}: {
  readonly children: React.ReactNode;
  readonly delay?: number;
  readonly className?: string;
}) {
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y: 40 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-10% 0px' }}
      transition={{ duration: 1.1, delay, ease: EASE }}
    >
      {children}
    </motion.div>
  );
}

/* ------------------------------------------------------------------ manifesto */

const MANIFESTO =
  'Most apps compete for your attention. Focus Flow gives it back. Choose one thing. Give it twenty-five quiet minutes. Let the work add up, day after day.';

function ManifestoWord({
  word,
  index,
  total,
  progress,
}: {
  readonly word: string;
  readonly index: number;
  readonly total: number;
  readonly progress: MotionValue<number>;
}) {
  const start = index / total;
  const opacity = useTransform(progress, [start, start + 1 / total], [0.14, 1]);
  return (
    <motion.span style={{ opacity }} className="mr-[0.25em] inline-block">
      {word}
    </motion.span>
  );
}

/** A large serif statement whose words light up one by one as the reader scrolls. */
export function Manifesto() {
  const ref = useRef<HTMLDivElement>(null);
  const { scrollYProgress } = useScroll({ target: ref, offset: ['start 0.85', 'end 0.45'] });
  const words = MANIFESTO.split(' ');
  return (
    <section
      aria-label="Why Focus Flow"
      className="relative bg-[var(--l-paper)] px-6 py-40 text-[var(--l-text-dark)] md:px-16"
    >
      <DappledShade />
      <p className="mb-10 text-xs tracking-[0.3em] text-[var(--l-muted-dark)] uppercase">
        ( Our belief )
      </p>
      <div ref={ref}>
        <p className="ff-serif max-w-6xl text-5xl leading-[1.05] md:text-7xl lg:text-8xl">
          <span className="sr-only">{MANIFESTO}</span>
          <span aria-hidden="true">
            {words.map((word, index) => (
              <ManifestoWord
                key={`${word}-${String(index)}`}
                word={word}
                index={index}
                total={words.length}
                progress={scrollYProgress}
              />
            ))}
          </span>
        </p>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ rooms */

const FRIENDS = [
  { initial: 'A', hue: '#c8a15a' },
  { initial: 'M', hue: '#8fb8a8' },
  { initial: 'K', hue: '#d9a7a0' },
  { initial: 'R', hue: '#a7b4d9' },
  { initial: 'S', hue: '#e7c27d' },
  { initial: 'J', hue: '#b8c99a' },
] as const;

const CHAT = [
  'Starting the 9 o’clock run 🌿',
  'In. Phone is in the other room.',
  'Halfway there, keep going',
  'Done! That was a good one.',
] as const;

/** Friends orbiting a shared timer, with chat drifting by. */
export function RoomsShowcase() {
  const [message, setMessage] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { margin: '-20% 0px' });

  useEffect(() => {
    if (!inView) {
      return undefined;
    }
    const id = setInterval(() => {
      setMessage((value) => (value + 1) % CHAT.length);
    }, 2600);
    return () => {
      clearInterval(id);
    };
  }, [inView]);

  return (
    <section
      id="rooms"
      aria-label="Focus rooms"
      className="relative grid items-center gap-16 bg-[var(--l-paper)] px-6 py-32 text-[var(--l-text-dark)] md:grid-cols-[1.1fr_1fr] md:px-16"
    >
      <DappledShade />
      <Critter kind="toucan" className="top-6 right-[6%] hidden md:block" bubble="left">
        <ToucanArt flip />
      </Critter>
      <div ref={ref} className="relative mx-auto aspect-square w-full max-w-[520px]">
        <div className="absolute inset-[22%] flex flex-col items-center justify-center rounded-full bg-[var(--l-ink)] text-[var(--l-paper)] shadow-[0_30px_80px_rgb(17_20_28_/_0.35)]">
          <span className="text-[10px] tracking-[0.3em] text-[var(--l-gold)] uppercase">
            Shared focus
          </span>
          <span className="ff-serif text-6xl">18:42</span>
          <span className="text-xs text-[var(--l-muted-light)]">6 focusing together</span>
        </div>
        <div className="ff-orbit absolute inset-0">
          {FRIENDS.map((friend, index) => {
            const a = (index / FRIENDS.length) * Math.PI * 2;
            return (
              <div
                key={friend.initial}
                className="absolute"
                style={{
                  left: `${String(50 + Math.cos(a) * 44)}%`,
                  top: `${String(50 + Math.sin(a) * 44)}%`,
                  transform: 'translate(-50%, -50%)',
                }}
              >
                <div
                  className="ff-counter-orbit grid h-14 w-14 place-items-center rounded-full border-4 border-[var(--l-paper)] text-lg font-medium text-[var(--l-ink)] shadow-lg"
                  style={{ background: friend.hue }}
                >
                  {friend.initial}
                </div>
              </div>
            );
          })}
        </div>
        <div className="absolute -bottom-2 left-1/2 w-72 -translate-x-1/2" aria-live="off">
          <AnimatePresence mode="wait">
            <motion.div
              key={message}
              initial={{ opacity: 0, y: 16, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -12 }}
              transition={{ duration: 0.6, ease: EASE }}
              className="rounded-2xl rounded-bl-sm bg-white px-4 py-3 text-sm shadow-lg"
            >
              {CHAT[message]}
            </motion.div>
          </AnimatePresence>
        </div>
      </div>

      <Reveal>
        <p className="mb-6 text-xs tracking-[0.3em] text-[var(--l-muted-dark)] uppercase">
          ( Focus rooms )
        </p>
        <h2 className="ff-serif text-5xl leading-[1.05] md:text-7xl">
          Better,
          <br />
          <em>together.</em>
        </h2>
        <ul className="mt-10 space-y-5 text-[var(--l-muted-dark)]">
          <li className="border-t border-[var(--l-text-dark)]/15 pt-5">
            <strong className="font-medium text-[var(--l-text-dark)]">One shared timer.</strong> The
            host sets the rhythm; everyone sees the same seconds.
          </li>
          <li className="border-t border-[var(--l-text-dark)]/15 pt-5">
            <strong className="font-medium text-[var(--l-text-dark)]">
              Opt in, never assumed.
            </strong>{' '}
            Being in the room isn’t the same as focusing. You choose to join each run.
          </li>
          <li className="border-t border-[var(--l-text-dark)]/15 pt-5">
            <strong className="font-medium text-[var(--l-text-dark)]">Public or private.</strong>{' '}
            Share a six-letter code, or let people knock first.
          </li>
        </ul>
      </Reveal>
    </section>
  );
}

/* ------------------------------------------------------------------ insights */

/** Deterministic sample intensity for a weekday/hour cell (mornings and early evenings). */
function sampleIntensity(day: number, hour: number): number {
  const morning = Math.exp(-((hour - 10) ** 2) / 6);
  const evening = Math.exp(-((hour - 19) ** 2) / 4) * 0.6;
  const weekend = day >= 5 ? 0.45 : 1;
  const noise = (Math.sin(day * 12.9898 + hour * 78.233) * 43758.5453) % 1;
  return Math.max(0, Math.min(1, (morning + evening) * weekend * (0.7 + Math.abs(noise) * 0.5)));
}

function CountUp({ to, suffix = '' }: { readonly to: number; readonly suffix?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const inView = useInView(ref, { once: true });
  const [value, setValue] = useState(0);
  useEffect(() => {
    if (!inView) {
      return undefined;
    }
    const controls = animate(0, to, {
      duration: 2,
      ease: EASE,
      onUpdate: (latest) => {
        setValue(Math.round(latest));
      },
    });
    return () => {
      controls.stop();
    };
  }, [inView, to]);
  return (
    <span ref={ref}>
      {value}
      {suffix}
    </span>
  );
}

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

/** A preview of the insights view: an hour-of-day heatmap and headline numbers. */
export function InsightsShowcase() {
  const grid = useRef<HTMLDivElement>(null);
  const inView = useInView(grid, { once: true, margin: '-15% 0px' });
  return (
    <section
      id="insights"
      aria-label="Insights"
      className="relative bg-[var(--l-ink)] px-6 py-32 md:px-16"
    >
      <Fireflies count={14} />
      <Mist />
      <CreepingRoots edge="top" seed={31} />
      <Critter kind="owl" className="top-10 right-[4%] hidden md:block" bubble="left">
        <OwlArt />
      </Critter>
      <div className="grid gap-12 md:grid-cols-[1fr_1.4fr] md:items-end">
        <Reveal>
          <p className="mb-6 text-xs tracking-[0.3em] text-[var(--l-gold)] uppercase">
            ( Insights )
          </p>
          <h2 className="ff-serif text-5xl leading-[1.05] md:text-7xl">
            Know your
            <br />
            <em className="text-[var(--l-gold-soft)]">best hours.</em>
          </h2>
          <dl className="mt-12 grid grid-cols-3 gap-6">
            <div>
              <dt className="text-xs text-[var(--l-muted-light)]">Day streak</dt>
              <dd className="ff-serif text-5xl">
                <CountUp to={23} />
              </dd>
            </div>
            <div>
              <dt className="text-xs text-[var(--l-muted-light)]">Hours this week</dt>
              <dd className="ff-serif text-5xl">
                <CountUp to={14} />
              </dd>
            </div>
            <div>
              <dt className="text-xs text-[var(--l-muted-light)]">Completion</dt>
              <dd className="ff-serif text-5xl">
                <CountUp to={86} suffix="%" />
              </dd>
            </div>
          </dl>
          <p className="mt-6 text-xs text-[var(--l-muted-light)]">Sample data, for illustration.</p>
        </Reveal>

        <div
          ref={grid}
          aria-hidden="true"
          className="rounded-[2rem] border border-white/10 bg-[var(--l-ink-2)] p-6 md:p-8"
        >
          <div className="mb-4 flex justify-between text-[10px] tracking-widest text-[var(--l-muted-light)] uppercase">
            <span>Focus by hour</span>
            <span>6am → 11pm</span>
          </div>
          <div className="space-y-1.5">
            {DAYS.map((day, d) => (
              <div key={day} className="flex items-center gap-1.5">
                <span className="w-8 text-[10px] text-[var(--l-muted-light)]">{day}</span>
                {Array.from({ length: 18 }, (_, h) => {
                  const intensity = sampleIntensity(d, h + 6);
                  return (
                    <motion.span
                      key={h}
                      className="aspect-square flex-1 rounded-[4px]"
                      style={{
                        background: `rgb(200 161 90 / ${String(0.06 + intensity * 0.94)})`,
                      }}
                      initial={{ opacity: 0, scale: 0.4 }}
                      animate={inView ? { opacity: 1, scale: 1 } : {}}
                      transition={{ duration: 0.5, delay: (d * 18 + h) * 0.006, ease: EASE }}
                    />
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ marquee */

const PRINCIPLES = [
  'One task',
  'Twenty-five minutes',
  'No noise',
  'Show up daily',
  'Rest on purpose',
  'Together, quietly',
] as const;

/** A slow ribbon of principles; its speed nudges with scroll velocity. */
export function Marquee() {
  const { scrollY } = useScroll();
  const [skew, setSkew] = useState(0);
  const last = useRef(0);
  useMotionValueEvent(scrollY, 'change', (latest) => {
    const velocity = latest - last.current;
    last.current = latest;
    setSkew(Math.max(-6, Math.min(6, velocity * 0.15)));
  });
  const items = [...PRINCIPLES, ...PRINCIPLES];
  return (
    <div
      aria-hidden="true"
      className="overflow-hidden border-y border-[var(--l-gold)]/30 bg-[var(--l-ink)] py-8"
    >
      <div
        className="transition-transform duration-500"
        style={{ transform: `skewX(${String(-skew)}deg)` }}
      >
        <div className="ff-marquee flex w-max gap-12 whitespace-nowrap">
          {[...items, ...items].map((item, index) => (
            <span
              key={index}
              className="ff-condensed flex items-center gap-12 text-6xl text-[var(--l-paper)] md:text-8xl"
            >
              {item}
              <span className="text-3xl text-[var(--l-gold)]">✦</span>
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
