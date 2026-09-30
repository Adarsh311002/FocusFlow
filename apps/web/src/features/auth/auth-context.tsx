import type { AuthResponse, UserView } from '@focus-flow/contracts';
import { useQueryClient } from '@tanstack/react-query';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';

import {
  fetchMe,
  login as requestLogin,
  logout as requestLogout,
  onSessionEnded,
  restoreSession,
  signup as requestSignup,
} from './auth-client';
import { setAccessToken } from './token-store';

export type AuthStatus = 'loading' | 'authenticated' | 'anonymous';

interface AuthState {
  /** Only the rendered projection of the session lives in React state — never the token. */
  readonly user: UserView | null;
  readonly status: AuthStatus;
}

export interface AuthContextValue extends AuthState {
  readonly login: (email: string, password: string) => Promise<void>;
  readonly signup: (email: string, password: string, displayName: string) => Promise<void>;
  readonly logout: () => Promise<void>;
  /**
   * Replaces the signed-in user with a fresher copy from the server (for example the
   * `{ user }` that `PUT /me/current-task` returns). Ignored when signed out.
   */
  readonly updateUser: (user: UserView) => void;
  /** Re-reads `GET /me`, for changes the server made as a side effect (D43). */
  readonly reloadUser: () => Promise<void>;
}

const ANONYMOUS: AuthState = { user: null, status: 'anonymous' };
const LOADING: AuthState = { user: null, status: 'loading' };

const AuthContext = createContext<AuthContextValue | null>(null);

/**
 * Owns the session as the UI sees it. The token itself lives in `token-store.ts`; this
 * provider only mirrors what the session means for rendering.
 *
 * On mount it asks the API once whether the refresh cookie still names a live session,
 * because after a reload there is no other way to know. `status` stays `'loading'` until
 * that answer arrives so nothing redirects on a session that turns out to be valid.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>(LOADING);
  // Server data cached by TanStack Query belongs to one session. It is cleared whenever
  // the session changes (sign-in, sign-up, sign-out, or the session ending on its own), so
  // one user's tasks can never be rendered — even briefly — for the next user of the tab.
  const queryClient = useQueryClient();

  useEffect(() => {
    let active = true;

    void restoreSession().then(
      (user) => {
        if (active) {
          setState(user === null ? ANONYMOUS : { user, status: 'authenticated' });
        }
      },
      () => {
        // `restoreSession` already absorbs every API-level failure, so reaching this is a
        // defect rather than a session state. Signed-out is the safe thing to render.
        if (active) {
          setState(ANONYMOUS);
        }
      },
    );

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    // Catches a session ending mid-app-lifetime (e.g. a background query discovers the
    // refresh cookie is dead), which no component's login/logout call would otherwise
    // surface — without this, the UI would keep rendering a stale authenticated state.
    return onSessionEnded(() => {
      queryClient.clear();
      setState(ANONYMOUS);
    });
  }, [queryClient]);

  const accept = useCallback(
    (response: AuthResponse) => {
      // A new session may belong to a different person than the last one in this tab, so
      // nothing cached for the previous session may be shown to it.
      queryClient.clear();
      setAccessToken(response.accessToken);
      setState({ user: response.user, status: 'authenticated' });
    },
    [queryClient],
  );

  /** Errors reach the form that asked, which is what shows them; nothing is swallowed. */
  const reject = useCallback(
    (error: unknown): never => {
      queryClient.clear();
      setAccessToken(null);
      setState(ANONYMOUS);
      throw error;
    },
    [queryClient],
  );

  const login = useCallback(
    async (email: string, password: string) => {
      try {
        accept(await requestLogin({ email, password }));
      } catch (error) {
        reject(error);
      }
    },
    [accept, reject],
  );

  const signup = useCallback(
    async (email: string, password: string, displayName: string) => {
      try {
        accept(await requestSignup({ email, password, displayName }));
      } catch (error) {
        reject(error);
      }
    },
    [accept, reject],
  );

  const logout = useCallback(async () => {
    try {
      await requestLogout();
    } finally {
      // Whether or not the server answered, this browser is done with the session, and
      // with every piece of server data it fetched for it.
      queryClient.clear();
      setState(ANONYMOUS);
    }
  }, [queryClient]);

  const updateUser = useCallback((user: UserView) => {
    setState((current) =>
      current.status === 'authenticated' && current.user?.id === user.id
        ? { user, status: 'authenticated' }
        : current,
    );
  }, []);

  const reloadUser = useCallback(async () => {
    updateUser(await fetchMe());
  }, [updateUser]);

  const value = useMemo<AuthContextValue>(
    () => ({ ...state, login, signup, logout, updateUser, reloadUser }),
    [state, login, signup, logout, updateUser, reloadUser],
  );

  return <AuthContext value={value}>{children}</AuthContext>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (value === null) {
    throw new Error('useAuth must be called inside an <AuthProvider>.');
  }
  return value;
}
