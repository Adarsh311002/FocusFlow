import { Link, Outlet, useNavigate, useRouterState } from '@tanstack/react-router';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';

import { useAuth } from '../features/auth/auth-context';
import { authErrorMessage } from '../features/auth/auth-messages';
import { ForestUnlocks } from '../features/forest/forest-unlocks';
import { dailyGoalOf, useSetDailyGoal } from '../features/intention/intention-queries';
import { DailyIntentionRitual } from '../features/intention/intention-ritual';
import { useOptionalRealtimeStatus } from '../features/realtime/realtime-provider';
import { avatarGlyph } from '../features/settings/settings-page';
import { WeeklyReviewRitual } from '../features/weekly/weekly-ritual';
import { AmbientBackground } from '../ui/ambient-background';
import { JungleAttention, JungleHint } from '../ui/jungle/critters';
import { HangingCanopy } from '../ui/jungle/foliage';
import { ForestSoundToggle } from '../ui/jungle/sound-toggle';
import { playLeafTick } from '../ui/jungle/soundscape';
import { NeuronMark } from '../ui/neuron-mark';
import { buttonClass } from '../ui/primitives';
import { useTheme } from '../ui/theme';

const SECTIONS = [
  { to: '/dashboard', label: 'Dashboard' },
  { to: '/review', label: 'Review' },
  { to: '/rooms', label: 'Rooms' },
  // Below lg the header has no room for more links; Goals and the forest are in the account
  // menu there (and the forest also on the dashboard card).
  { to: '/goals', label: 'Goals', wideOnly: true },
  { to: '/forest', label: 'Forest', wideOnly: true },
] as const;

const EASE = [0.22, 1, 0.36, 1] as const;

/** The signed-in sections of the app; shown only once the session is known to be live. */
export function AppNav() {
  const { status } = useAuth();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  if (status !== 'authenticated') {
    return null;
  }
  return (
    <nav aria-label="Main">
      <ul className="flex items-center">
        {SECTIONS.map((section) => {
          const active = pathname === section.to || pathname.startsWith(`${section.to}/`);
          return (
            <li
              key={section.to}
              className={'wideOnly' in section ? 'relative hidden lg:block' : 'relative'}
            >
              {active && (
                <motion.span
                  layoutId="app-nav-active"
                  className="absolute inset-0 rounded-full bg-surface-strong shadow-glow"
                  transition={{ duration: 0.45, ease: EASE }}
                />
              )}
              <Link
                to={section.to}
                onMouseEnter={playLeafTick}
                className="relative block rounded-full px-3 py-2 text-sm text-muted transition-colors hover:text-ink sm:px-4"
                activeProps={{ 'aria-current': 'page', className: 'text-ink' }}
              >
                {section.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

const LIVE_LABEL = {
  idle: 'Offline',
  connecting: 'Syncing',
  connected: 'Live',
  reconnecting: 'Syncing',
} as const;

/** A small live-connection dot, only for signed-in users. */
function LiveDot() {
  const { status } = useAuth();
  const live = useOptionalRealtimeStatus();
  if (status !== 'authenticated' || live === null) {
    return null;
  }
  const on = live === 'connected';
  return (
    <span
      className="hidden items-center gap-2 rounded-full px-3 py-2 text-xs text-muted sm:flex"
      title={`Live connection: ${LIVE_LABEL[live]}`}
    >
      <span className="relative flex h-2 w-2">
        {on && (
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-ok opacity-60" />
        )}
        <span className={`relative inline-flex h-2 w-2 rounded-full ${on ? 'bg-ok' : 'bg-warm'}`} />
      </span>
      {LIVE_LABEL[live]}
    </span>
  );
}

/** The header's theme switch. On a phone, once signed in, it moves into the account menu so
    the navigation fits the header. */
function ThemeToggle() {
  const { status } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const next = theme === 'dark' ? 'light' : 'dark';
  return (
    <button
      type="button"
      onClick={toggleTheme}
      aria-label={`Switch to ${next} theme`}
      className={`${status === 'authenticated' ? 'hidden sm:grid' : 'grid'} h-9 w-9 place-items-center rounded-full text-sm text-muted transition hover:bg-surface-strong hover:text-ink`}
    >
      {theme === 'dark' ? '☀' : '☾'}
    </button>
  );
}

/** The theme switch inside the account menu, shown only where the header hides its own. */
function MenuThemeToggle() {
  const { theme, toggleTheme } = useTheme();
  const next = theme === 'dark' ? 'light' : 'dark';
  return (
    <button
      type="button"
      role="menuitem"
      onClick={toggleTheme}
      className={buttonClass('ghost', 'w-full sm:hidden')}
    >
      {`Switch to ${next} theme`}
    </button>
  );
}

/** The signed-in user's initial, opening a small menu with who is signed in and Sign out. */
function AccountMenu() {
  const { status, user, logout } = useAuth();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      return undefined;
    }
    const onPointer = (event: PointerEvent): void => {
      if (!root.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setOpen(false);
      }
    };
    window.addEventListener('pointerdown', onPointer);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onPointer);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (status !== 'authenticated' || user === null) {
    return null;
  }

  async function signOut(): Promise<void> {
    setError(null);
    setSigningOut(true);
    try {
      await logout();
      setOpen(false);
      await navigate({ to: '/login' });
    } catch (cause) {
      setError(authErrorMessage(cause));
    } finally {
      setSigningOut(false);
    }
  }

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Account: ${user.displayName}`}
        onClick={() => {
          setOpen((value) => !value);
        }}
        className="grid h-9 w-9 place-items-center rounded-full bg-focus font-display text-lg text-focus-ink transition hover:brightness-110"
      >
        {avatarGlyph(user)}
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            role="menu"
            initial={{ opacity: 0, y: -6, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.97 }}
            transition={{ duration: 0.2 }}
            className="absolute top-12 right-0 w-64 space-y-3 rounded-3xl border border-line bg-canvas-2/95 p-5 shadow-card backdrop-blur-2xl"
          >
            <div>
              <p className="font-display text-2xl">{user.displayName}</p>
              <p className="text-xs text-muted">{user.email}</p>
            </div>
            <DailyGoalSetting />
            <Link
              to="/settings"
              role="menuitem"
              onClick={() => {
                setOpen(false);
              }}
              className={buttonClass('ghost', 'w-full')}
            >
              All settings
            </Link>
            <Link
              to="/forest"
              role="menuitem"
              onClick={() => {
                setOpen(false);
              }}
              className={buttonClass('ghost', 'w-full lg:hidden')}
            >
              Your forest
            </Link>
            <Link
              to="/goals"
              role="menuitem"
              onClick={() => {
                setOpen(false);
              }}
              className={buttonClass('ghost', 'w-full lg:hidden')}
            >
              Goals
            </Link>
            <MenuThemeToggle />
            <button
              type="button"
              role="menuitem"
              disabled={signingOut}
              onClick={() => {
                void signOut();
              }}
              className={buttonClass('ghost', 'w-full')}
            >
              {signingOut ? 'Signing out…' : 'Sign out'}
            </button>
            {error !== null && (
              <p role="alert" className="text-xs text-danger">
                {error}
              </p>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** App chrome: ambient background, a floating capsule bar and the active route. */
export function RootLayout() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  if (pathname === '/') {
    // The landing page is its own full-bleed world with its own navigation.
    return <Outlet />;
  }
  return (
    <div className="ff-grain relative min-h-screen text-ink">
      <AmbientBackground />
      <HangingCanopy variant="app" />
      <header className="sticky top-0 z-40 flex justify-center px-4 pt-4">
        <div className="flex w-full max-w-6xl items-center justify-between gap-3 rounded-full border border-line bg-canvas-2/70 px-3 py-2 shadow-card backdrop-blur-2xl">
          <Link to="/" className="flex items-center gap-2 pl-2">
            <NeuronMark />
            <h1 className="sr-only font-display text-xl sm:not-sr-only">Focus Flow</h1>
          </Link>
          <AppNav />
          <div className="flex items-center gap-1">
            <LiveDot />
            <ThemeToggle />
            <AccountMenu />
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl px-6 pt-10 pb-20">
        <Outlet />
      </main>
      <ForestSoundToggle />
      <ForestUnlocks />
      <WeeklyReviewRitual />
      <DailyIntentionRitual />
      <JungleAttention />
      <JungleHint />
    </div>
  );
}

const GOAL_HOURS: readonly number[] = [1, 2, 3, 4, 5, 6, 8];

function hoursText(hours: number): string {
  return hours === 1 ? '1 hour' : `${String(Math.round(hours * 10) / 10)} hours`;
}

/** The daily focus goal (A2), changeable any time from the account menu. */
function DailyGoalSetting() {
  const { user } = useAuth();
  const setGoal = useSetDailyGoal();
  const hours = dailyGoalOf(user) / 3600;
  const listed = GOAL_HOURS.includes(hours);
  return (
    <div className="space-y-1">
      <label htmlFor="daily-goal-setting" className="block text-xs text-muted">
        Daily focus goal
      </label>
      <select
        id="daily-goal-setting"
        value={listed ? String(hours) : ''}
        disabled={setGoal.isPending}
        onChange={(event) => {
          const next = Number(event.target.value);
          if (next > 0) {
            setGoal.mutate(next * 3600);
          }
        }}
        className="w-full text-sm"
      >
        {!listed && <option value="">{hoursText(hours)}</option>}
        {GOAL_HOURS.map((option) => (
          <option key={option} value={String(option)}>
            {hoursText(option)}
          </option>
        ))}
      </select>
      {setGoal.isError && <p className="text-xs text-danger">The goal did not save. Try again.</p>}
    </div>
  );
}
