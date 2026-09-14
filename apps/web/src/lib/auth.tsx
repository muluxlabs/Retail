/**
 * Session state for the web app.
 *
 * The session lives in an httpOnly cookie the browser cannot read, so this
 * holds only what /auth/me returns. Permissions are used to decide what to
 * SHOW; they are never the thing that enforces access. The API refuses on its
 * own authority, and hiding a button is a courtesy, not a control.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

import { api, ApiError, type CurrentUser } from './api.js';

interface AuthState {
  user: CurrentUser | null;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  refresh: () => Promise<void>;
  /** True when this user holds the named capability. */
  can: (permission: string) => boolean;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      setUser(await api.me());
    } catch (error) {
      // 401 here is the normal signed-out case, not a failure worth surfacing.
      if (!(error instanceof ApiError) || error.status !== 401) {
        // eslint-disable-next-line no-console
        console.error('Could not load session', error);
      }
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const signIn = useCallback(async (email: string, password: string) => {
    const result = await api.login({ email, password });
    setUser(result.user);
  }, []);

  const signOut = useCallback(async () => {
    await api.logout();
    setUser(null);
  }, []);

  const value = useMemo<AuthState>(
    () => ({
      user,
      loading,
      signIn,
      signOut,
      refresh,
      can: (permission) => user?.permissions.includes(permission) ?? false,
    }),
    [user, loading, signIn, signOut, refresh],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const context = useContext(AuthContext);
  if (context === null) throw new Error('useAuth must be used inside AuthProvider');
  return context;
}
