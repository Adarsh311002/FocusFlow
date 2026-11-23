import { Link } from '@tanstack/react-router';
import {
  AnimatePresence,
  motion,
  useMotionValue,
  useScroll,
  useSpring,
  useTransform,
} from 'motion/react';
import { lazy, Suspense, useEffect, useState } from 'react';

import {
  ButterflyArt,
  Critter,
  EyesArt,
  JungleAttention,
  JungleHint,
  MonkeyArt,
} from '../../ui/jungle/critters';
import {
  CornerFoliage,
  CreepingRoots,
  DappledShade,
  Fireflies,
  HangingCanopy,
  LightRays,
  Mist,
} from '../../ui/jungle/foliage';
import { ForestSoundToggle } from '../../ui/jungle/sound-toggle';
import { useAuth } from '../auth/auth-context';
import { LandingFooter, LandingNav } from './landing-chrome';
import { InsightsShowcase, Manifesto, Marquee, Reveal, RoomsShowcase } from './landing-sections';
import { Comparison, WhyStory } from './landing-story';

const LandingScene = lazy(() => import('../../ui/jungle/ancient-tree-scene'));

const EASE = [0.22, 1, 0.36, 1] as const;
const INTRO_KEY = 'ff-intro-seen';

function prefersReducedMotion(): boolean {
  return (
    typeof window.matchMedia !== 'function' ||
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

function canUseWebGl(): boolean {
  try {
    const canvas = document.createElement('canvas');
    return canvas.getContext('webgl2') !== null || canvas.getContext('webgl') !== null;
  } catch {
    return false;
  }
}

function introAlreadySeen(): boolean {
  try {
    return window.sessionStorage.getItem(INTRO_KEY) === '1';
  } catch {
    return false;
  }
}

/** A short cinematic curtain on the first visit of a browser session. */
function IntroCurtain() {
  const [visible, setVisible] = useState(() => !introAlreadySeen() && !prefersReducedMotion());
  useEffect(() => {
    if (!visible) {
      return undefined;
    }
    const id = setTimeout(() => {
      setVisible(false);
      try {
        window.sessionStorage.setItem(INTRO_KEY, '1');
      } catch {
        // Only means the intro plays again next time.
      }
    }, 2200);
    return () => {
      clearTimeout(id);
    };
  }, [visible]);

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          aria-hidden="true"
          className="fixed inset-0 z-[70] flex flex-col items-center justify-center bg-[var(--l-ink)]"
          exit={{ clipPath: 'inset(0 0 100% 0)' }}
          transition={{ duration: 1.1, ease: EASE }}
        >
          <motion.p
            className="ff-serif text-6xl text-[var(--l-paper)] md:text-8xl"
            initial={{ opacity: 0, y: 20, filter: 'blur(12px)' }}
            animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
            transition={{ duration: 1.2, ease: EASE }}
          >
            Focus Flow
          </motion.p>
          <motion.p
            className="mt-4 text-xs tracking-[0.4em] text-[var(--l-gold)] uppercase"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 1, delay: 0.7 }}
          >
            Breathe in
          </motion.p>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function Hero({ signedIn }: { readonly signedIn: boolean }) {
  const [show3d] = useState(() => !prefersReducedMotion() && canUseWebGl());
  const { scrollY } = useScroll();
  const headlineY = useTransform(scrollY, [0, 800], [0, 220]);
  const headlineOpacity = useTransform(scrollY, [0, 600], [1, 0]);
  // A soft gold light that trails the cursor.
  const glowX = useSpring(useMotionValue(0), { stiffness: 60, damping: 20 });
  const glowY = useSpring(useMotionValue(0), { stiffness: 60, damping: 20 });

  return (
    <section
      aria-labelledby="hero-heading"
      className="relative h-[100svh] min-h-[680px] overflow-hidden bg-[var(--l-ink)]"
      onPointerMove={(event) => {
        glowX.set(event.clientX - 300);
        glowY.set(event.clientY - 300);
      }}
    >
      <motion.div
        aria-hidden="true"
        className="pointer-events-none absolute top-0 left-0 h-[600px] w-[600px] rounded-full bg-[radial-gradient(circle,rgb(226_189_95_/_0.14),transparent_65%)]"
        style={{ x: glowX, y: glowY }}
      />

      <LightRays />
      <Fireflies />
      <Mist />
      <CornerFoliage side="left" />
      <CornerFoliage side="right" />

      <div aria-hidden="true" className="absolute inset-0 md:left-[12%]">
        {show3d ? (
          <Suspense fallback={null}>
            <LandingScene />
          </Suspense>
        ) : (
          <div className="ff-breathe absolute top-1/2 left-1/2 h-72 w-72 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[radial-gradient(circle,var(--l-gold-soft),transparent_70%)] opacity-60 blur-xl" />
        )}
      </div>

      <motion.p
        aria-hidden="true"
        className="absolute top-[42%] left-6 z-10 hidden text-[10px] leading-relaxed tracking-[0.3em] text-[var(--l-muted-light)] uppercase md:left-16 md:block"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 1, delay: 1.4 }}
      >
        <span className="text-[var(--l-gold)]">●</span> Older than any deadline
        <br />
        Something is watching · tap the animals
      </motion.p>

      <motion.div
        style={{ y: headlineY, opacity: headlineOpacity }}
        className="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex flex-col gap-8 px-6 pb-10 md:flex-row md:items-end md:justify-between md:px-16 md:pb-14"
      >
        <h1
          id="hero-heading"
          className="ff-condensed text-[17vw] leading-[0.82] text-[var(--l-paper)] md:text-[9.5vw]"
        >
          <span className="block overflow-hidden">
            <motion.span
              className="block"
              initial={{ y: '110%' }}
              animate={{ y: 0 }}
              transition={{ duration: 1.3, delay: 0.3, ease: EASE }}
            >
              Focus deep
            </motion.span>
          </span>
          <span className="block overflow-hidden">
            <motion.span
              className="block text-transparent [-webkit-text-stroke:1.5px_var(--l-gold)]"
              initial={{ y: '110%' }}
              animate={{ y: 0 }}
              transition={{ duration: 1.3, delay: 0.45, ease: EASE }}
            >
              Drift less
            </motion.span>
          </span>
        </h1>

        <motion.div
          className="pointer-events-auto max-w-sm space-y-6 md:pb-3"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 1.2, delay: 0.9, ease: EASE }}
        >
          <p className="ff-serif text-2xl leading-snug text-[var(--l-paper)] md:text-3xl">
            A quiet place to do your best work,{' '}
            <em className="text-[var(--l-gold-soft)]">alone or together.</em>
          </p>
          <div className="flex flex-wrap gap-3">
            <Link
              to={signedIn ? '/dashboard' : '/signup'}
              className="rounded-full bg-[var(--l-gold)] px-7 py-3.5 text-sm font-medium text-[var(--l-ink)] shadow-[0_0_40px_rgb(200_161_90_/_0.35)] transition hover:bg-[var(--l-gold-soft)]"
            >
              {signedIn ? 'Back to focusing' : 'Begin a session, free'}
            </Link>
            <a
              href="#why"
              className="rounded-full border border-white/20 px-7 py-3.5 text-sm text-[var(--l-paper)] transition hover:border-[var(--l-paper)]"
            >
              Why Focus Flow
            </a>
          </div>
        </motion.div>
      </motion.div>
      <CreepingRoots edge="bottom" seed={7} />
      <Critter kind="jaguar" className="bottom-[36%] left-[62%] hidden md:block" bubble="above">
        <EyesArt />
      </Critter>
      <Critter kind="monkey" className="top-0 right-[16%] hidden md:block" bubble="left">
        <MonkeyArt vine={150} />
      </Critter>
      <Critter kind="butterfly" className="top-[22%] left-[26%] hidden md:block" bubble="right">
        <ButterflyArt />
      </Critter>
    </section>
  );
}

function FinalCall({ signedIn }: { readonly signedIn: boolean }) {
  return (
    <section
      aria-label="Get started"
      className="relative flex min-h-[80vh] flex-col items-center justify-center bg-[var(--l-paper)] px-6 py-32 text-center text-[var(--l-text-dark)]"
    >
      <DappledShade />
      <Critter kind="butterfly" className="top-24 right-[14%]" bubble="left">
        <ButterflyArt hue="#2a5fb8" />
      </Critter>
      <Reveal>
        <p className="mb-8 text-xs tracking-[0.3em] text-[var(--l-muted-dark)] uppercase">
          ( Your next deep session )
        </p>
        <h2 className="ff-serif text-[22vw] leading-[0.8] md:text-[14vw]">
          Begin<span className="text-[var(--l-gold)]">.</span>
        </h2>
        <Link
          to={signedIn ? '/dashboard' : '/signup'}
          className="mt-12 inline-flex items-center gap-3 rounded-full bg-[var(--l-ink)] px-9 py-4 text-[var(--l-paper)] transition hover:gap-5 hover:bg-[var(--l-text-dark)]"
        >
          {signedIn ? 'Open your dashboard' : 'Create your free account'}
          <span aria-hidden="true">→</span>
        </Link>
      </Reveal>
    </section>
  );
}

/** The public landing page: its own full-bleed world, outside the app chrome. */
export function LandingPage() {
  const { status } = useAuth();
  const signedIn = status === 'authenticated';
  return (
    <div className="ff-landing ff-grain">
      <IntroCurtain />
      <HangingCanopy />
      <JungleAttention />
      <JungleHint />
      <ForestSoundToggle />
      <LandingNav signedIn={signedIn} />
      <main>
        <Hero signedIn={signedIn} />
        <Manifesto />
        <WhyStory />
        <Marquee />
        <Comparison />
        <RoomsShowcase />
        <InsightsShowcase />
        <FinalCall signedIn={signedIn} />
      </main>
      <LandingFooter signedIn={signedIn} />
    </div>
  );
}
