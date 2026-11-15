/**
 * App-wide auth + onboarding state, and the Backend instance.
 *
 * `status` drives routing in app/_layout.tsx:
 *   loading -> splash, signed_out -> sign-in, needs_onboarding -> onboarding,
 *   ready -> the plan.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import type { AppSession, Backend } from '../api';

export type SessionStatus = 'loading' | 'signed_out' | 'needs_onboarding' | 'ready' | 'error';

interface SessionValue {
  backend: Backend;
  status: SessionStatus;
  session: AppSession | null;
  error: unknown;
  /** Re-reads the profile (after onboarding, or to retry after an error). */
  refreshProfile: () => Promise<void>;
  signOut: () => Promise<void>;
  /** The signed-in session; throws if called while signed out (use inside protected screens). */
  requireSession: () => AppSession;
}

const SessionContext = createContext<SessionValue | null>(null);

export function SessionProvider({ backend, children }: { backend: Backend; children: ReactNode }) {
  const [session, setSession] = useState<AppSession | null>(null);
  const [status, setStatus] = useState<SessionStatus>('loading');
  const [error, setError] = useState<unknown>(null);
  const userIdRef = useRef<string | null>(null);

  const resolveProfile = useCallback(
    async (s: AppSession | null) => {
      if (!s) {
        setStatus('signed_out');
        return;
      }
      try {
        const profile = await backend.getProfile(s.userId);
        setError(null);
        setStatus(profile?.onboarding_completed === true ? 'ready' : 'needs_onboarding');
      } catch (e) {
        setError(e);
        setStatus('error');
      }
    },
    [backend],
  );

  useEffect(() => {
    let alive = true;
    backend
      .getSession()
      .then((s) => {
        if (!alive) return;
        userIdRef.current = s?.userId ?? null;
        setSession(s);
        return resolveProfile(s);
      })
      .catch((e: unknown) => {
        if (!alive) return;
        setError(e);
        setStatus('signed_out');
      });
    const unsubscribe = backend.onSessionChange((s) => {
      const prevUser = userIdRef.current;
      userIdRef.current = s?.userId ?? null;
      setSession(s);
      // Token refreshes keep the same user: update the token, don't re-route.
      if (!(prevUser && s && prevUser === s.userId)) void resolveProfile(s);
    });
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [backend, resolveProfile]);

  const value = useMemo<SessionValue>(
    () => ({
      backend,
      status,
      session,
      error,
      refreshProfile: () => resolveProfile(session),
      signOut: async () => {
        try {
          await backend.signOut();
        } finally {
          userIdRef.current = null;
          setSession(null);
          setStatus('signed_out');
        }
      },
      requireSession: () => {
        if (!session) throw new Error('No session: this screen must be behind the signed-in guard.');
        return session;
      },
    }),
    [backend, status, session, error, resolveProfile],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const v = useContext(SessionContext);
  if (!v) throw new Error('useSession must be used inside <SessionProvider>.');
  return v;
}
