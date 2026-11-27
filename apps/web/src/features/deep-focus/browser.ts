// The browser features Deep Focus leans on (DF1, DF5). Each one is optional: a browser
// without it (or a test environment) simply goes without, and nothing throws.

/** Whether this browser can show a page in full screen at all (iPhone Safari cannot). */
export function fullscreenSupported(): boolean {
  return (
    typeof document !== 'undefined' && 'fullscreenEnabled' in document && document.fullscreenEnabled
  );
}

export function isFullscreen(): boolean {
  return (
    typeof document !== 'undefined' &&
    'fullscreenElement' in document &&
    document.fullscreenElement !== null
  );
}

/** Must run inside the click (or key press) that asked for it; browsers refuse otherwise. */
export function enterFullscreen(): void {
  if (!fullscreenSupported() || isFullscreen()) {
    return;
  }
  document.documentElement.requestFullscreen().catch(() => {
    // Refused (no user gesture, or a browser policy): the guard treats it as "away".
  });
}

export function exitFullscreen(): void {
  if (isFullscreen()) {
    document.exitFullscreen().catch(() => {
      // Already left.
    });
  }
}

/** "Is the user here?": the tab is visible, the window focused, and full screen kept. */
export function userIsPresent(): boolean {
  if (typeof document === 'undefined') {
    return true;
  }
  const visible = document.visibilityState === 'visible';
  const focused = document.hasFocus();
  return visible && focused && (!fullscreenSupported() || isFullscreen());
}

// ---- Which tab watches the session -----------------------------------------------------
// Only the tab that started (or took over) a Deep Focus session watches it. Another tab of
// the app, which is hidden by definition, would otherwise break the session at once.

const OWNER_KEY = 'ff-deep-focus-owner';

export function claimDeepFocus(sessionId: string): void {
  try {
    window.sessionStorage.setItem(OWNER_KEY, sessionId);
  } catch {
    // Without storage this tab cannot remember; the layer offers "Continue here" again.
  }
}

export function ownsDeepFocus(sessionId: string): boolean {
  try {
    return window.sessionStorage.getItem(OWNER_KEY) === sessionId;
  } catch {
    return false;
  }
}

// ---- Keep the screen awake -------------------------------------------------------------

type WakeLockLike = { release: () => Promise<void> };
type WakeLockNavigator = Navigator & {
  wakeLock: { request: (type: 'screen') => Promise<WakeLockLike> };
};

/** Asks for a screen wake lock; returns how to let it go. Lost on its own when hidden. */
export function keepScreenAwake(): () => void {
  if (!('wakeLock' in navigator)) {
    return () => undefined;
  }
  const wakeLock = (navigator as WakeLockNavigator).wakeLock;
  let lock: WakeLockLike | null = null;
  let released = false;
  const request = (): void => {
    wakeLock
      .request('screen')
      .then((granted) => {
        if (released) {
          void granted.release();
        } else {
          lock = granted;
        }
      })
      .catch(() => {
        // Not allowed (battery saver, a hidden tab): the session goes on without it.
      });
  };
  // The browser drops the lock whenever the tab is hidden; ask again when it is back.
  const onVisible = (): void => {
    if (document.visibilityState === 'visible') {
      request();
    }
  };
  request();
  document.addEventListener('visibilitychange', onVisible);
  return () => {
    released = true;
    document.removeEventListener('visibilitychange', onVisible);
    void lock?.release();
  };
}
