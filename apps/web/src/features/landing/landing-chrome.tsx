import { Link } from '@tanstack/react-router';
import { AnimatePresence, motion, useMotionValueEvent, useScroll } from 'motion/react';
import { useEffect, useState } from 'react';

import { CornerFoliage, CreepingRoots } from '../../ui/jungle/foliage';
import { playLeafTick } from '../../ui/jungle/soundscape';
import { NeuronMark } from '../../ui/neuron-mark';

const EASE = [0.22, 1, 0.36, 1] as const;

const LINKS = [
  { href: '#why', label: 'Why Focus Flow' },
  { href: '#rooms', label: 'Rooms' },
  { href: '#insights', label: 'Insights' },
] as const;

/**
 * A floating glass capsule. It slides away while the reader scrolls down and returns as
 * soon as they scroll up; links share one sliding highlight.
 */
export function LandingNav({ signedIn }: { readonly signedIn: boolean }) {
  const { scrollY } = useScroll();
  const [hidden, setHidden] = useState(false);
  const [condensed, setCondensed] = useState(false);
  const [hovered, setHovered] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  useMotionValueEvent(scrollY, 'change', (latest) => {
    const previous = scrollY.getPrevious() ?? 0;
    setHidden(latest > previous && latest > 240 && !menuOpen);
    setCondensed(latest > 40);
  });

  useEffect(() => {
    document.body.style.overflow = menuOpen ? 'hidden' : '';
    return () => {
      document.body.style.overflow = '';
    };
  }, [menuOpen]);

  return (
    <>
      <motion.header
        className="fixed inset-x-0 top-0 z-50 flex justify-center px-4 pt-4"
        animate={{ y: hidden ? -110 : 0 }}
        transition={{ duration: 0.5, ease: EASE }}
      >
        <div
          className={`flex w-full max-w-5xl items-center justify-between gap-4 rounded-full border px-3 py-2 transition-all duration-500 ${
            condensed
              ? 'border-white/10 bg-[var(--l-ink-2)]/75 shadow-[0_20px_60px_rgb(0_0_0_/_0.45)] backdrop-blur-2xl'
              : 'border-white/5 bg-white/[0.03] backdrop-blur-md'
          }`}
        >
          <Link to="/" className="flex items-center gap-2 pl-2 text-[var(--l-paper)]">
            <NeuronMark />
            <span className="ff-serif text-xl">Focus Flow</span>
          </Link>

          <nav aria-label="Landing" className="hidden md:block">
            <ul
              className="flex items-center"
              onMouseLeave={() => {
                setHovered(null);
              }}
            >
              {LINKS.map((link) => (
                <li key={link.href} className="relative">
                  {hovered === link.href && (
                    <motion.span
                      layoutId="nav-hover"
                      className="absolute inset-0 rounded-full bg-white/[0.07]"
                      transition={{ duration: 0.35, ease: EASE }}
                    />
                  )}
                  <a
                    href={link.href}
                    onMouseEnter={() => {
                      setHovered(link.href);
                      playLeafTick();
                    }}
                    className="relative block px-4 py-2 text-sm text-[var(--l-muted-light)] transition-colors hover:text-[var(--l-paper)]"
                  >
                    {link.label}
                  </a>
                </li>
              ))}
            </ul>
          </nav>

          <div className="flex items-center gap-2">
            {!signedIn && (
              <Link
                to="/login"
                className="hidden rounded-full px-4 py-2 text-sm text-[var(--l-paper)] transition hover:bg-white/[0.07] sm:block"
              >
                Sign in
              </Link>
            )}
            <Link
              to={signedIn ? '/dashboard' : '/signup'}
              className="group flex items-center gap-2 rounded-full bg-[var(--l-gold)] py-2 pr-2 pl-5 text-sm font-medium text-[var(--l-ink)] transition hover:bg-[var(--l-gold-soft)]"
            >
              {signedIn ? 'Dashboard' : 'Start focusing'}
              <span className="grid h-7 w-7 place-items-center rounded-full bg-[var(--l-ink)] text-[var(--l-gold-soft)] transition-transform duration-300 group-hover:translate-x-0.5 group-hover:-rotate-45">
                →
              </span>
            </Link>
            <button
              type="button"
              aria-label={menuOpen ? 'Close menu' : 'Open menu'}
              aria-expanded={menuOpen}
              onClick={() => {
                setMenuOpen((open) => !open);
              }}
              className="grid h-10 w-10 place-items-center rounded-full border border-white/10 md:hidden"
            >
              <span className="relative block h-3 w-4">
                <span
                  className={`absolute left-0 h-px w-4 bg-[var(--l-paper)] transition-all ${menuOpen ? 'top-1.5 rotate-45' : 'top-0'}`}
                />
                <span
                  className={`absolute left-0 h-px w-4 bg-[var(--l-paper)] transition-all ${menuOpen ? 'top-1.5 -rotate-45' : 'top-3'}`}
                />
              </span>
            </button>
          </div>
        </div>
      </motion.header>

      <AnimatePresence>
        {menuOpen && (
          <motion.div
            className="fixed inset-0 z-40 flex flex-col justify-end bg-[var(--l-ink)] px-8 pb-16 md:hidden"
            initial={{ clipPath: 'circle(0% at 90% 5%)' }}
            animate={{ clipPath: 'circle(150% at 90% 5%)' }}
            exit={{ clipPath: 'circle(0% at 90% 5%)' }}
            transition={{ duration: 0.7, ease: EASE }}
          >
            {LINKS.map((link, index) => (
              <motion.a
                key={link.href}
                href={link.href}
                onClick={() => {
                  setMenuOpen(false);
                }}
                className="ff-serif border-b border-white/10 py-4 text-5xl text-[var(--l-paper)]"
                initial={{ opacity: 0, y: 30 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.25 + index * 0.07, duration: 0.6, ease: EASE }}
              >
                {link.label}
              </motion.a>
            ))}
            {!signedIn && (
              <Link to="/login" className="mt-8 text-lg text-[var(--l-muted-light)]">
                Sign in
              </Link>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}

function LocalClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => {
      setNow(new Date());
    }, 1000);
    return () => {
      clearInterval(id);
    };
  }, []);
  return (
    <time dateTime={now.toISOString()} className="tabular-nums">
      {now.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
    </time>
  );
}

/** An editorial footer: a statement, link columns, a live clock and a giant wordmark. */
export function LandingFooter({ signedIn }: { readonly signedIn: boolean }) {
  return (
    <footer className="relative overflow-hidden bg-[var(--l-ink)] px-6 pt-24 text-[var(--l-muted-light)] md:px-16">
      <CreepingRoots edge="top" seed={5} />
      <CornerFoliage side="left" />
      <CornerFoliage side="right" />
      <div className="grid gap-14 border-b border-white/10 pb-16 md:grid-cols-[1.4fr_1fr_1fr_1fr]">
        <div className="max-w-sm">
          <p className="ff-serif text-4xl leading-tight text-[var(--l-paper)]">
            Your attention is the most valuable thing you own.{' '}
            <em className="text-[var(--l-gold-soft)]">Spend it on purpose.</em>
          </p>
          <Link
            to={signedIn ? '/dashboard' : '/signup'}
            className="group mt-8 inline-flex items-center gap-3 text-sm text-[var(--l-paper)]"
          >
            <span className="border-b border-[var(--l-gold)] pb-1">
              {signedIn ? 'Open your dashboard' : 'Create your free account'}
            </span>
            <span className="transition-transform group-hover:translate-x-1">→</span>
          </Link>
        </div>
        <div>
          <p className="mb-5 text-xs tracking-[0.25em] text-[var(--l-gold)] uppercase">Explore</p>
          <ul className="space-y-3 text-sm">
            <li>
              <a href="#why" className="transition hover:text-[var(--l-paper)]">
                Why Focus Flow
              </a>
            </li>
            <li>
              <a href="#rooms" className="transition hover:text-[var(--l-paper)]">
                Focus rooms
              </a>
            </li>
            <li>
              <a href="#insights" className="transition hover:text-[var(--l-paper)]">
                Insights
              </a>
            </li>
          </ul>
        </div>
        <div>
          <p className="mb-5 text-xs tracking-[0.25em] text-[var(--l-gold)] uppercase">Account</p>
          <ul className="space-y-3 text-sm">
            <li>
              <Link to="/login" className="transition hover:text-[var(--l-paper)]">
                Sign in
              </Link>
            </li>
            <li>
              <Link to="/signup" className="transition hover:text-[var(--l-paper)]">
                Create account
              </Link>
            </li>
            <li>
              <Link to="/status" className="transition hover:text-[var(--l-paper)]">
                System status
              </Link>
            </li>
          </ul>
        </div>
        <div>
          <p className="mb-5 text-xs tracking-[0.25em] text-[var(--l-gold)] uppercase">Right now</p>
          <p className="ff-serif text-3xl text-[var(--l-paper)]">
            <LocalClock />
          </p>
          <p className="mt-2 text-sm">A good minute to start.</p>
          <button
            type="button"
            onClick={() => {
              window.scrollTo({ top: 0, behavior: 'smooth' });
            }}
            className="mt-6 inline-flex items-center gap-2 rounded-full border border-white/15 px-4 py-2 text-xs text-[var(--l-paper)] transition hover:border-[var(--l-gold)] hover:text-[var(--l-gold-soft)]"
          >
            Back to top <span aria-hidden="true">↑</span>
          </button>
        </div>
      </div>

      <div className="flex flex-col justify-between gap-2 py-6 text-xs md:flex-row">
        <span>© {new Date().getFullYear()} Focus Flow</span>
        <span>Decide · Focus · Record · Review</span>
      </div>

      <motion.p
        aria-hidden="true"
        className="ff-serif pointer-events-none -mb-[0.2em] text-center text-[24vw] leading-[0.8] whitespace-nowrap select-none"
        initial={{ y: '40%', opacity: 0 }}
        whileInView={{ y: 0, opacity: 1 }}
        viewport={{ once: true }}
        transition={{ duration: 1.4, ease: EASE }}
        style={{
          background: 'linear-gradient(180deg, var(--l-gold-soft), rgb(200 161 90 / 0.05))',
          WebkitBackgroundClip: 'text',
          backgroundClip: 'text',
          color: 'transparent',
        }}
      >
        Focus Flow
      </motion.p>
    </footer>
  );
}
