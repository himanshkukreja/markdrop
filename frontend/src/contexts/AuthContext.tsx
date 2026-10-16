"use client";

import { createContext, useContext, useEffect, useState, useCallback } from "react";
import { ApiError, fetchMe, getToken, setToken, clearToken, logoutRequest, MeUser } from "@/lib/api";
import AuthModal from "@/components/AuthModal";
import { track } from "@/lib/track";
import { identifyUser, resetIdentity } from "@/lib/thirdPartyAnalytics";

interface AuthModalOptions {
  next?: string;
  title?: string;
  message?: string;
  onSuccess?: () => void;
}

interface AuthState {
  user: MeUser | null;
  loading: boolean;
  login: (token: string, user?: MeUser) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
  updateUser: (user: MeUser) => void;
  /** Open the in-place sign-in / sign-up modal (defaults `next` to the current URL). */
  openAuthModal: (opts?: AuthModalOptions) => void;
}

const AuthContext = createContext<AuthState | undefined>(undefined);

// Waits between attempts when /auth/me fails for a reason other than a rejected
// token (a network error or a 5xx, e.g. while the API restarts).
const RETRY_DELAYS_MS = [2000, 5000, 15000];

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<MeUser | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!getToken()) {
      setUser(null);
      setLoading(false);
      return;
    }
    for (let attempt = 0; ; attempt++) {
      try {
        setUser(await fetchMe());
        break;
      } catch (e) {
        // Only a 401 means the token is no good. Anything else keeps the token
        // (and any user already loaded) and tries again.
        if (e instanceof ApiError && e.status === 401) {
          clearToken();
          setUser(null);
          break;
        }
        if (attempt >= RETRY_DELAYS_MS.length || !getToken()) break;
        await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
      }
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Link this browser's analytics history to the account (PostHog/GA, consent permitting).
  useEffect(() => {
    if (user) identifyUser(user);
  }, [user]);

  const login = useCallback(async (token: string, u?: MeUser) => {
    setToken(token);
    track("logged_in");
    if (u) {
      setUser(u);
      setLoading(false);
    } else {
      await refresh();
    }
  }, [refresh]);

  const logout = useCallback(async () => {
    await logoutRequest();
    clearToken();
    setUser(null);
    resetIdentity();
  }, []);

  const updateUser = useCallback((u: MeUser) => setUser(u), []);

  const [authModal, setAuthModal] = useState<AuthModalOptions | null>(null);
  const openAuthModal = useCallback((opts?: AuthModalOptions) => setAuthModal(opts ?? {}), []);

  return (
    <AuthContext.Provider value={{ user, loading, login, logout, refresh, updateUser, openAuthModal }}>
      {children}
      {authModal && (
        <AuthModal
          next={
            authModal.next ??
            (typeof window !== "undefined" ? window.location.pathname + window.location.search : "/dashboard")
          }
          title={authModal.title}
          message={authModal.message}
          onSuccess={authModal.onSuccess}
          onClose={() => setAuthModal(null)}
        />
      )}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
