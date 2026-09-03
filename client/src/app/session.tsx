import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { JSX, ReactNode } from 'react';
import { SESSION_EXPIRED_EVENT, auth } from '../api/index.js';
import type { SafeUser } from '../api/types.js';
import { capabilitiesFor } from '../lib/status.js';
import type { Capabilities } from '../lib/status.js';
import { clearCsrfToken } from '../api/client.js';

/**
 * Session state for the whole SPA.
 *
 * The authoritative session lives in an httpOnly cookie; this context only
 * mirrors the public user projection returned by `GET /api/auth/me` so the UI
 * can scope navigation and disable actions the role cannot perform.
 */

export type SessionStatus = 'loading' | 'authenticated' | 'anonymous';

export interface SessionValue {
  user: SafeUser | null;
  roleLabel: string;
  demoMode: boolean;
  status: SessionStatus;
  capabilities: Capabilities;
  /** Adopt a session established by login, MFA or an accepted invitation. */
  adopt: (user: SafeUser) => void;
  signOut: () => Promise<void>;
  refresh: () => Promise<void>;
}

const SessionContext = createContext<SessionValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }): JSX.Element {
  const [user, setUser] = useState<SafeUser | null>(null);
  const [roleLabel, setRoleLabel] = useState('');
  const [demoMode, setDemoMode] = useState(false);
  const [status, setStatus] = useState<SessionStatus>('loading');

  const refresh = useCallback(async () => {
    try {
      const session = await auth.me();
      setUser(session.user);
      setRoleLabel(session.roleLabel);
      setDemoMode(session.demoMode);
      setStatus('authenticated');
    } catch {
      clearCsrfToken();
      setUser(null);
      setStatus('anonymous');
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const onExpired = () => {
      clearCsrfToken();
      setUser(null);
      setStatus('anonymous');
    };
    window.addEventListener(SESSION_EXPIRED_EVENT, onExpired);
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, onExpired);
  }, []);

  const adopt = useCallback((next: SafeUser) => {
    setUser(next);
    setStatus('authenticated');
  }, []);

  const signOut = useCallback(async () => {
    try {
      await auth.logout();
    } catch {
      /* Logging out must always leave the user signed out locally. */
    }
    clearCsrfToken();
    setUser(null);
    setRoleLabel('');
    setStatus('anonymous');
  }, []);

  const value = useMemo<SessionValue>(
    () => ({
      user,
      roleLabel,
      demoMode,
      status,
      capabilities: capabilitiesFor(user?.role),
      adopt,
      signOut,
      refresh,
    }),
    [user, roleLabel, demoMode, status, adopt, signOut, refresh],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const context = useContext(SessionContext);
  if (!context) throw new Error('useSession must be used inside <SessionProvider>.');
  return context;
}
