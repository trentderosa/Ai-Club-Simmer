/**
 * App-wide auth + onboarding state, and the Backend instance.
 *
 * `status` drives routing in app/_layout.tsx:
 *   loading -> splash, signed_out -> sign-in, set_password -> reset-password,
 *   needs_onboarding -> onboarding, ready -> the plan.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import type { AppSession, Backend } from '../api';

export type SessionStatus = 'loading' | 'signed_out' | 'set_password' | 'needs_onboarding' | 'ready' | 'error';
export type RecoveryMode = 'form' | 'failed';

interface SessionValue {
  backend: Backend;
  status: SessionStatus;
  /** Set while `status` is `set_password`. */
  recovery: RecoveryMode | null;
  session: AppSession | null;
  error: unknown;
  /** Re-reads the profile (after onboarding, or to retry after an error). */
  refreshProfile: () => Promise<void>;
  signOut: () => Promise<void>;
  /** Leaves the recovery screen and opens Today or onboarding. */
  finishPasswordReset: () => Promise<void>;
  /** Closes a failed link when it does not belong to the signed-in account. */
  dismissRecoveryFailure: () => Promise<void>;
  /** The signed-in session; throws if called while signed out (use inside protected screens). */
  requireSession: () => AppSession;
}

const SessionContext = createContext<SessionValue | null>(null);

export function SessionProvider({ backend, children }: { backend: Backend; children: ReactNode }) {
  const [session, setSession] = useState<AppSession | null>(null);
  const [status, setStatus] = useState<SessionStatus>('loading');
  const [recovery, setRecovery] = useState<RecoveryMode | null>(null);
  const [error, setError] = useState<unknown>(null);
  const userIdRef = useRef<string | null>(null);
  const sessionRef = useRef<AppSession | null>(null);

  const resolveProfile = useCallback(
    async (s: AppSession | null) => {
      if (backend.passwordRecoveryFailed()) {
        setRecovery('failed');
        setStatus('set_password');
        return;
      }
      if (s && backend.passwordResetOwns(s.userId) && backend.passwordRecoveryPending()) {
        setRecovery('form');
        setStatus('set_password');
        return;
      }
      setRecovery(null);
      if (!s) {
        setStatus('signed_out');
        return;
      }
      try {
        const profile = await backend.getProfile(s.userId);
        if (backend.passwordRecoveryFailed()) {
          setRecovery('failed');
          setStatus('set_password');
          return;
        }
        if (backend.passwordResetOwns(s.userId) && backend.passwordRecoveryPending()) {
          setRecovery('form');
          setStatus('set_password');
          return;
        }
        setError(null);
        setStatus(profile?.onboarding_completed === true ? 'ready' : 'needs_onboarding');
      } catch (e) {
        if (backend.passwordRecoveryFailed() || (backend.passwordResetOwns(s.userId) && backend.passwordRecoveryPending())) {
          setRecovery(backend.passwordRecoveryFailed() ? 'failed' : 'form');
          setStatus('set_password');
          return;
        }
        setError(e);
        setStatus('error');
      }
    },
    [backend],
  );

  useEffect(() => {
    let alive = true;
    backend
      .prepareAuth()
      .then(() => backend.getSession())
      .then((s) => {
        if (!alive) return;
        userIdRef.current = s?.userId ?? null;
        sessionRef.current = s;
        setSession(s);
        return resolveProfile(s);
      })
      .catch((e: unknown) => {
        if (!alive) return;
        if (backend.passwordRecoveryFailed() || backend.passwordRecoveryPending()) {
          setRecovery(backend.passwordRecoveryFailed() ? 'failed' : 'form');
          setStatus('set_password');
          return;
        }
        backend.clearPasswordRecovery();
        setError(e);
        setRecovery(null);
        setStatus('signed_out');
      });
    const unsubscribe = backend.onSessionChange((s, change) => {
      const prevUser = userIdRef.current;
      userIdRef.current = s?.userId ?? null;
      sessionRef.current = s;
      setSession(s);
      if (!alive) return;
      const stay =
        backend.passwordRecoveryFailed() ||
        (s !== null && backend.passwordResetOwns(s.userId) && backend.passwordRecoveryPending()) ||
        change === 'password_recovery' ||
        change === 'password_recovery_failed';
      if (!stay && change === 'token_refresh' && prevUser && s && prevUser === s.userId) return;
      void resolveProfile(s);
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
      recovery,
      session,
      error,
      refreshProfile: () => resolveProfile(session),
      signOut: async () => {
        backend.clearPasswordRecovery();
        try {
          await backend.signOut();
        } finally {
          userIdRef.current = null;
          sessionRef.current = null;
          setSession(null);
          setRecovery(null);
          setStatus('signed_out');
        }
      },
      finishPasswordReset: async () => {
        backend.clearPasswordRecovery();
        setRecovery(null);
        await resolveProfile(sessionRef.current);
      },
      dismissRecoveryFailure: async () => {
        backend.clearRecoveryFailure();
        const current = sessionRef.current;
        if (current && backend.passwordResetOwns(current.userId)) {
          backend.clearPasswordRecovery();
          try {
            await backend.signOut();
          } finally {
            userIdRef.current = null;
            sessionRef.current = null;
            setSession(null);
            setRecovery(null);
            setStatus('signed_out');
          }
          return;
        }
        setRecovery(null);
        await resolveProfile(current);
      },
      requireSession: () => {
        if (!session) throw new Error('No session: this screen must be behind the signed-in guard.');
        return session;
      },
    }),
    [backend, status, recovery, session, error, resolveProfile],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const v = useContext(SessionContext);
  if (!v) throw new Error('useSession must be used inside <SessionProvider>.');
  return v;
}
