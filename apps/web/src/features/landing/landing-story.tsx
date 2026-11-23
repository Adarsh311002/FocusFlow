import { AnimatePresence, motion, useInView } from 'motion/react';
import { type PointerEvent, type ReactNode, useEffect, useRef, useState } from 'react';

import { Critter, EyesArt, FrogArt, SlothArt } from '../../ui/jungle/critters';
import { CreepingRoots, DappledShade, Fireflies, Mist } from '../../ui/jungle/foliage';

const EASE = [0.22, 1, 0.36, 1] as const;

/* ------------------------------------------------------------------ chapter visuals */

function Frame({ children }: { readonly children: ReactNode }) {
  return (
    <motion.div
      className="absolute inset-0 flex items-center justify-center p-8"
      initial={{ opacity: 0, scale: 0.94, filter: 'blur(8px)' }}
      animate={{ opacity: 1, scale: 1, filter: 'blur(0px)' }}
      exit={{ opacity: 0, scale: 1.04, filter: 'blur(8px)' }}
      transition={{ duration: 0.7, ease: EASE }}
    >
      {children}
    </motion.div>
  );
}

/** Repeats a short sequence of steps while mounted. */
function useLoop(steps: number, ms: number): number {
  const [step, setStep] = useState(0);
  useEffect(() => {
    const id = setInterval(() => {
      setStep((value) => (value + 1) % steps);
    }, ms);
    return () => {
      clearInterval(id);
    };
  }, [steps, ms]);
  return step;
}

const TASKS = [
  'Reply to design feedback',
  'Draft the chapter outline',
  'Plan next sprint',
] as const;

function IntentVisual() {
  const step = useLoop(3, 1600);
  const chosen = step >= 1;
  return (
    <div className="w-full max-w-sm space-y-3">
      {TASKS.map((task, index) => {
        const isPick = index === 1;
        return (
          <motion.div
            key={task}
            layout
            animate={{
              opacity: chosen && !isPick ? 0.35 : 1,
              scale: chosen && isPick ? 1.05 : 1,
            }}
            transition={{ duration: 0.6, ease: EASE }}
            className={`flex items-center gap-3 rounded-2xl border px-5 py-4 ${
              chosen && isPick
                ? 'border-[var(--l-gold)] bg-[var(--l-gold)]/10 shadow-[0_0_40px_rgb(200_161_90_/_0.25)]'
                : 'border-white/10 bg-white/[0.03]'
            }`}
          >
            <span
              className={`h-2.5 w-2.5 rounded-full ${chosen && isPick ? 'bg-[var(--l-gold)]' : 'bg-white/25'}`}
            />
            <span className="text-[var(--l-paper)]">{task}</span>
            {chosen && isPick && (
              <span className="ml-auto text-xs tracking-wider text-[var(--l-gold)] uppercase">
                Current
              </span>
            )}
          </motion.div>
        );
      })}
      <AnimatePresence>
        {step === 2 && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.6, ease: EASE }}
            className="flex items-center justify-between rounded-2xl bg-[var(--l-paper)] px-5 py-4 text-[var(--l-ink)]"
          >
            <span className="text-sm">Focusing on the outline</span>
            <span className="ff-serif text-2xl">50:00</span>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

const HONEST_STEPS = [
  { tab: true, label: 'Session running', clock: '23:40', grace: null },
  { tab: false, label: 'Tab closed. The server keeps the clock.', clock: '23:31', grace: 60 },
  { tab: false, label: 'Reconnect grace', clock: '23:12', grace: 41 },
  { tab: true, label: 'Back within grace. Nothing lost.', clock: '23:05', grace: null },
] as const;

function HonestVisual() {
  const step = useLoop(HONEST_STEPS.length, 1900);
  const state = HONEST_STEPS[step] ?? HONEST_STEPS[0];
  return (
    <div className="grid w-full max-w-md grid-cols-2 gap-4">
      <motion.div
        animate={{ opacity: state.tab ? 1 : 0.25, scale: state.tab ? 1 : 0.94 }}
        transition={{ duration: 0.6 }}
        className="rounded-2xl border border-white/10 bg-white/[0.03] p-4"
      >
        <div className="mb-4 flex gap-1.5">
          <span className="h-2 w-2 rounded-full bg-white/20" />
          <span className="h-2 w-2 rounded-full bg-white/20" />
          <span className="h-2 w-2 rounded-full bg-white/20" />
        </div>
        <p className="text-[10px] tracking-widest text-[var(--l-muted-light)] uppercase">
          Your browser
        </p>
        <p className="ff-serif mt-2 text-4xl text-[var(--l-paper)]">
          {state.tab ? state.clock : '—'}
        </p>
      </motion.div>
      <div className="rounded-2xl border border-[var(--l-gold)]/50 bg-[var(--l-gold)]/[0.06] p-4">
        <div className="mb-4 flex items-center gap-2">
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--l-gold)] opacity-75" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-[var(--l-gold)]" />
          </span>
          <span className="text-[10px] tracking-widest text-[var(--l-gold)] uppercase">
            Server clock
          </span>
        </div>
        <p className="text-[10px] tracking-widest text-[var(--l-muted-light)] uppercase">
          Source of truth
        </p>
        <p className="ff-serif mt-2 text-4xl text-[var(--l-paper)]">{state.clock}</p>
      </div>
      <div className="col-span-2 rounded-2xl border border-white/10 p-4">
        <div className="flex items-center justify-between text-sm">
          <span className="text-[var(--l-paper)]">{state.label}</span>
          {state.grace !== null && (
            <span className="text-[var(--l-gold-soft)]">{state.grace}s grace</span>
          )}
        </div>
        <div className="mt-3 h-1 overflow-hidden rounded-full bg-white/10">
          <motion.div
            className="h-full bg-[var(--l-gold)]"
            animate={{
              width: state.grace === null ? '100%' : `${String((state.grace / 60) * 100)}%`,
            }}
            transition={{ duration: 1.2, ease: EASE }}
          />
        </div>
      </div>
    </div>
  );
}

const PEOPLE = [
  { name: 'Asha', focusing: true },
  { name: 'Marco', focusing: true },
  { name: 'Kenji', focusing: false },
  { name: 'Riya', focusing: true },
  { name: 'Sam', focusing: false },
  { name: 'Jo', focusing: true },
] as const;

function TogetherVisual() {
  const step = useLoop(2, 2200);
  return (
    <div className="w-full max-w-md">
      <div className="mb-6 flex items-end justify-between">
        <div>
          <p className="text-[10px] tracking-widest text-[var(--l-gold)] uppercase">
            Morning writers · Focus
          </p>
          <p className="ff-serif text-6xl text-[var(--l-paper)]">
            {step === 0 ? '31:08' : '31:06'}
          </p>
        </div>
        <p className="text-right text-xs text-[var(--l-muted-light)]">
          4 focusing
          <br />6 here
        </p>
      </div>
      <div className="grid grid-cols-3 gap-3">
        {PEOPLE.map((person) => (
          <div
            key={person.name}
            className={`rounded-2xl border p-4 text-center transition ${
              person.focusing
                ? 'border-[var(--l-gold)]/60 bg-[var(--l-gold)]/[0.07]'
                : 'border-white/10 bg-white/[0.02]'
            }`}
          >
            <div
              className={`mx-auto grid h-12 w-12 place-items-center rounded-full text-lg ${
                person.focusing
                  ? 'bg-[var(--l-gold)] text-[var(--l-ink)] shadow-[0_0_24px_rgb(200_161_90_/_0.5)]'
                  : 'bg-white/10 text-[var(--l-paper)]'
              }`}
            >
              {person.name.charAt(0)}
            </div>
            <p className="mt-2 text-sm text-[var(--l-paper)]">{person.name}</p>
            <p className="text-[10px] text-[var(--l-muted-light)]">
              {person.focusing ? 'Focusing' : 'Just here'}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}

function RhythmVisual() {
  const goal = 0.72;
  const circumference = 2 * Math.PI * 70;
  return (
    <div className="grid w-full max-w-md grid-cols-2 items-center gap-6">
      <div className="relative mx-auto h-44 w-44">
        <svg viewBox="0 0 160 160" className="h-full w-full -rotate-90">
          <circle
            cx="80"
            cy="80"
            r="70"
            fill="none"
            stroke="rgb(255 255 255 / 0.08)"
            strokeWidth="10"
          />
          <motion.circle
            cx="80"
            cy="80"
            r="70"
            fill="none"
            stroke="var(--l-gold)"
            strokeWidth="10"
            strokeLinecap="round"
            strokeDasharray={circumference}
            initial={{ strokeDashoffset: circumference }}
            animate={{ strokeDashoffset: circumference * (1 - goal) }}
            transition={{ duration: 1.6, ease: EASE }}
          />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="ff-serif text-4xl text-[var(--l-paper)]">2h 53m</span>
          <span className="text-[10px] tracking-widest text-[var(--l-muted-light)] uppercase">
            of 4h goal
          </span>
        </div>
      </div>
      <div className="space-y-5">
        <div>
          <p className="text-[10px] tracking-widest text-[var(--l-muted-light)] uppercase">
            Streak
          </p>
          <p className="ff-serif text-5xl text-[var(--l-gold-soft)]">23 days</p>
        </div>
        <div>
          <p className="mb-2 text-[10px] tracking-widest text-[var(--l-muted-light)] uppercase">
            Best hours
          </p>
          <div className="flex gap-1">
            {[0.1, 0.3, 0.8, 1, 0.9, 0.4, 0.2, 0.15, 0.5, 0.7, 0.3, 0.1].map((value, index) => (
              <motion.span
                key={index}
                className="h-8 flex-1 rounded-sm"
                style={{ background: `rgb(200 161 90 / ${String(0.08 + value * 0.92)})` }}
                initial={{ scaleY: 0 }}
                animate={{ scaleY: 1 }}
                transition={{ duration: 0.5, delay: index * 0.05, ease: EASE }}
              />
            ))}
          </div>
          <div className="mt-1 flex justify-between text-[10px] text-[var(--l-muted-light)]">
            <span>8am</span>
            <span>8pm</span>
          </div>
        </div>
      </div>
    </div>
  );
}

const LENGTHS = [15, 25, 50, 90, 240] as const;

function LengthVisual() {
  const step = useLoop(LENGTHS.length, 1300);
  const minutes = LENGTHS[step] ?? 25;
  return (
    <div className="w-full max-w-md">
      <p className="ff-serif text-[8rem] leading-none text-[var(--l-paper)]">
        <motion.span key={minutes} initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}>
          {minutes}
        </motion.span>
        <span className="ml-3 text-2xl text-[var(--l-muted-light)]">min</span>
      </p>
      <div className="mt-8 flex h-24 items-end gap-3">
        {LENGTHS.map((length) => (
          <motion.div
            key={length}
            className="flex-1 rounded-t-lg"
            animate={{
              height: `${String(Math.max(12, (length / 240) * 100))}%`,
              backgroundColor: length === minutes ? 'rgb(200 161 90)' : 'rgb(255 255 255 / 0.1)',
            }}
            transition={{ duration: 0.6, ease: EASE }}
          />
        ))}
      </div>
      <div className="mt-2 flex gap-3 text-center text-[10px] text-[var(--l-muted-light)]">
        {LENGTHS.map((length) => (
          <span key={length} className="flex-1">
            {length}
          </span>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ the story */

interface Chapter {
  readonly kicker: string;
  readonly title: ReactNode;
  readonly body: string;
  readonly visual: () => ReactNode;
}

const CHAPTERS: readonly Chapter[] = [
  {
    kicker: 'Intent first',
    title: (
      <>
        Decide before
        <br />
        <em>you start.</em>
      </>
    ),
    body: 'Every session begins with one clear decision: the task that matters most right now. Your current task stays front and centre, so the timer serves the work instead of the other way round.',
    visual: () => <IntentVisual />,
  },
  {
    kicker: 'Honest time',
    title: (
      <>
        Kept by the server,
        <br />
        <em>not a browser tab.</em>
      </>
    ),
    body: 'Most timers live and die in one tab. In Focus Flow the server keeps the clock. Lose your connection and you get a 60-second grace to come back. A session only counts as completed if you were really there at the end.',
    visual: () => <HonestVisual />,
  },
  {
    kicker: 'Body doubling',
    title: (
      <>
        Focus is easier
        <br />
        <em>side by side.</em>
      </>
    ),
    body: 'Join a room, share one host-led timer, and choose to opt in to each focus run. Simply being in the room never counts as working. Only choosing to focus does. Presence is not productivity.',
    visual: () => <TogetherVisual />,
  },
  {
    kicker: 'Your rhythm',
    title: (
      <>
        Learn when you
        <br />
        <em>do your best work.</em>
      </>
    ),
    body: 'Streaks, a daily goal, completion rates and a map of your best hours. Plan your hardest work for your peaks instead of whenever a generic timer says go.',
    visual: () => <RhythmVisual />,
  },
  {
    kicker: 'Your length',
    title: (
      <>
        Not 25 minutes.
        <br />
        <em>Your minutes.</em>
      </>
    ),
    body: 'Some work needs a quick sprint, some needs a long dive. Sessions run from 1 to 240 minutes, and rooms set their own focus and break lengths.',
    visual: () => <LengthVisual />,
  },
];

function ChapterText({
  chapter,
  index,
  onActive,
}: {
  readonly chapter: Chapter;
  readonly index: number;
  readonly onActive: (index: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { amount: 0.6 });
  useEffect(() => {
    if (inView) {
      onActive(index);
    }
  }, [inView, index, onActive]);
  return (
    <div ref={ref} className="flex min-h-[85vh] flex-col justify-center py-16">
      <motion.div
        animate={{ opacity: inView ? 1 : 0.25 }}
        transition={{ duration: 0.6 }}
        className="max-w-lg"
      >
        <p className="mb-6 flex items-center gap-3 text-xs tracking-[0.3em] text-[var(--l-gold)] uppercase">
          <span className="ff-serif text-2xl tracking-normal">0{index + 1}</span>
          <span className="h-px w-10 bg-[var(--l-gold)]/50" />
          {chapter.kicker}
        </p>
        <h3 className="ff-serif text-5xl leading-[1.02] text-[var(--l-paper)] md:text-6xl">
          {chapter.title}
        </h3>
        <p className="mt-6 text-lg leading-relaxed text-[var(--l-muted-light)]">{chapter.body}</p>
        {/* On small screens the visual sits under its text instead of sticking beside it. */}
        <div className="relative mt-10 h-80 lg:hidden">
          <Frame>{chapter.visual()}</Frame>
        </div>
      </motion.div>
    </div>
  );
}

/** "Not another Pomodoro timer": five chapters, with a sticky visual that follows along. */
export function WhyStory() {
  const [active, setActive] = useState(0);
  const current = CHAPTERS[active] ?? CHAPTERS[0];
  if (current === undefined) {
    return null;
  }
  return (
    <section
      id="why"
      aria-labelledby="why-heading"
      className="relative bg-[var(--l-ink)] px-6 md:px-16"
    >
      <Fireflies count={16} />
      <Mist />
      <CreepingRoots edge="top" seed={23} />
      <Critter kind="jaguar" className="bottom-[8%] left-[2%] hidden lg:block" bubble="right">
        <EyesArt />
      </Critter>
      <Critter kind="sloth" className="top-20 right-[4%] hidden md:block" bubble="below">
        <SlothArt />
      </Critter>
      <div className="pt-32 pb-10">
        <p className="mb-6 text-xs tracking-[0.3em] text-[var(--l-gold)] uppercase">
          ( Why Focus Flow )
        </p>
        <h2
          id="why-heading"
          className="ff-condensed text-[13vw] leading-[0.85] text-[var(--l-paper)] md:text-[8vw]"
        >
          Not another
          <br />
          <span className="text-transparent [-webkit-text-stroke:1.5px_var(--l-gold)]">
            Pomodoro timer
          </span>
        </h2>
        <p className="ff-serif mt-8 max-w-2xl text-2xl text-[var(--l-muted-light)] md:text-3xl">
          Timers count minutes. Focus Flow protects the work: what you chose, whether you were
          really there, who you did it with, and what it adds up to.
        </p>
      </div>

      <div className="grid gap-10 lg:grid-cols-2">
        <div>
          {CHAPTERS.map((chapter, index) => (
            <ChapterText
              key={chapter.kicker}
              chapter={chapter}
              index={index}
              onActive={setActive}
            />
          ))}
        </div>
        <div className="hidden lg:block">
          <div className="sticky top-0 flex h-screen items-center">
            <div className="relative h-[70vh] w-full overflow-hidden rounded-[2.5rem] border border-white/10 bg-gradient-to-br from-[var(--l-ink-2)] to-[var(--l-ink)]">
              <div
                aria-hidden="true"
                className="absolute -top-1/3 -right-1/4 h-2/3 w-2/3 rounded-full bg-[var(--l-gold)]/10 blur-3xl"
              />
              <div className="absolute top-6 left-8 flex gap-2" aria-hidden="true">
                {CHAPTERS.map((chapter, index) => (
                  <span
                    key={chapter.kicker}
                    className={`h-1 rounded-full transition-all duration-500 ${
                      index === active ? 'w-10 bg-[var(--l-gold)]' : 'w-4 bg-white/15'
                    }`}
                  />
                ))}
              </div>
              <div aria-hidden="true">
                <AnimatePresence mode="wait">
                  <Frame key={current.kicker}>{current.visual()}</Frame>
                </AnimatePresence>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ comparison */

const ROWS = [
  ['Counts down 25 minutes', 'Starts from what you decided to work on'],
  ['Lives in one browser tab', 'Kept by the server, even if the tab closes'],
  ['Trusts whatever it is told', 'Completed only if you were there at the end'],
  ['You, alone', 'Rooms with a shared, host-led timer'],
  ['A number, then nothing', 'Streaks, daily goal and your best hours'],
  ['Fixed intervals', '1 to 240 minutes, your own room lengths'],
] as const;

/** Drag the divider: a typical timer app on one side, Focus Flow on the other. */
export function Comparison() {
  const [split, setSplit] = useState(50);
  const box = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  function fromPointer(event: PointerEvent<HTMLDivElement>): void {
    const rect = box.current?.getBoundingClientRect();
    if (rect === undefined) {
      return;
    }
    const percent = ((event.clientX - rect.left) / rect.width) * 100;
    setSplit(Math.min(92, Math.max(8, percent)));
  }

  /** With `split`, rows keep to their own half and the Focus Flow half aligns right. */
  const list = (side: 0 | 1, split = false) => (
    <ul className="space-y-0">
      {ROWS.map((row) => (
        <li
          key={row[0]}
          className={`flex items-center gap-4 border-b py-5 text-lg md:text-xl ${
            side === 0 ? 'border-[var(--l-text-dark)]/15' : 'border-white/10'
          } ${split && side === 1 ? 'flex-row-reverse text-right' : ''}`}
        >
          <span
            className={`grid h-7 w-7 shrink-0 place-items-center rounded-full text-xs ${
              side === 0
                ? 'border border-[var(--l-text-dark)]/30 text-[var(--l-muted-dark)]'
                : 'bg-[var(--l-gold)] text-[var(--l-ink)]'
            }`}
          >
            {side === 0 ? '✕' : '✓'}
          </span>
          <span className={split ? 'max-w-[40%]' : ''}>{row[side]}</span>
        </li>
      ))}
    </ul>
  );

  return (
    <section
      aria-labelledby="compare-heading"
      className="relative bg-[var(--l-paper)] px-6 py-32 text-[var(--l-text-dark)] md:px-16"
    >
      <DappledShade />
      <Critter kind="frog" className="-bottom-2 left-[3%] hidden md:block" bubble="right">
        <FrogArt />
      </Critter>
      <div className="mb-14 flex flex-wrap items-end justify-between gap-6">
        <h2 id="compare-heading" className="ff-serif text-5xl leading-[1.02] md:text-7xl">
          A timer counts.
          <br />
          <em>Focus Flow cares.</em>
        </h2>
        <p className="max-w-xs text-sm text-[var(--l-muted-dark)]">
          Drag the divider to compare a typical timer app with Focus Flow.
        </p>
      </div>

      {/* Screen readers get both lists as a plain table-like structure. */}
      <div className="sr-only">
        <h3>A typical timer app</h3>
        {list(0)}
        <h3>Focus Flow</h3>
        {list(1)}
      </div>

      <div
        ref={box}
        aria-hidden="true"
        className="relative hidden cursor-ew-resize touch-none overflow-hidden rounded-[2rem] select-none md:block"
        onPointerDown={(event) => {
          dragging.current = true;
          event.currentTarget.setPointerCapture(event.pointerId);
          fromPointer(event);
        }}
        onPointerMove={(event) => {
          if (dragging.current) {
            fromPointer(event);
          }
        }}
        onPointerUp={() => {
          dragging.current = false;
        }}
      >
        <div className="bg-[var(--l-paper-2)] px-8 py-10 md:px-14">
          <p className="mb-6 text-xs tracking-[0.3em] text-[var(--l-muted-dark)] uppercase">
            A typical timer app
          </p>
          {list(0, true)}
        </div>
        <div
          className="absolute inset-0 bg-[var(--l-ink)] px-8 py-10 text-[var(--l-paper)] md:px-14"
          style={{ clipPath: `inset(0 0 0 ${String(split)}%)` }}
        >
          <p className="mb-6 text-right text-xs tracking-[0.3em] text-[var(--l-gold)] uppercase">
            Focus Flow
          </p>
          {list(1, true)}
        </div>
        <div
          className="absolute inset-y-0 w-px bg-[var(--l-gold)]"
          style={{ left: `${String(split)}%` }}
        >
          <div className="absolute top-1/2 left-1/2 grid h-14 w-14 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full bg-[var(--l-gold)] text-[var(--l-ink)] shadow-[0_0_40px_rgb(200_161_90_/_0.6)]">
            ⟷
          </div>
        </div>
      </div>
      <div aria-hidden="true" className="space-y-4 md:hidden">
        <div className="rounded-[2rem] bg-[var(--l-paper-2)] p-6">
          <p className="mb-2 text-xs tracking-[0.3em] text-[var(--l-muted-dark)] uppercase">
            A typical timer app
          </p>
          {list(0)}
        </div>
        <div className="rounded-[2rem] bg-[var(--l-ink)] p-6 text-[var(--l-paper)]">
          <p className="mb-2 text-xs tracking-[0.3em] text-[var(--l-gold)] uppercase">Focus Flow</p>
          {list(1)}
        </div>
      </div>
    </section>
  );
}
