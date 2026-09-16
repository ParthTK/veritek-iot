import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { Session, User } from '@/types';
import {
  getSession,
  login as loginService,
  logout as logoutService,
  startLiveUpdates,
  stopLiveUpdates,
  updateSessionUser,
} from '@/services';

interface AuthContextValue {
  session: Session | null;
  user: User | null;
  isAuthenticated: boolean;
  signIn: (email: string, password: string) => Promise<{ ok: boolean; error?: string }>;
  signOut: () => void;
  updateUser: (user: User) => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(() => getSession());

  // Follow the backend only while signed in: the stream carries live readings
  // and a slow poll behind it covers a dropped connection.
  useEffect(() => {
    if (!session) {
      stopLiveUpdates();
      return undefined;
    }
    startLiveUpdates();
    return () => stopLiveUpdates();
  }, [session]);

  const signIn = useCallback(async (email: string, password: string) => {
    const result = await loginService(email, password);
    if (result.ok && result.session) setSession(result.session);
    return { ok: result.ok, error: result.error };
  }, []);

  const signOut = useCallback(() => {
    logoutService();
    setSession(null);
  }, []);

  const updateUser = useCallback((user: User) => {
    updateSessionUser(user);
    setSession((prev) => (prev ? { ...prev, user } : prev));
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      session,
      user: session?.user ?? null,
      isAuthenticated: session !== null,
      signIn,
      signOut,
      updateUser,
    }),
    [session, signIn, signOut, updateUser],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
