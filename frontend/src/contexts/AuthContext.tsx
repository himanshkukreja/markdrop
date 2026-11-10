"use client";

import { createContext, useContext, useEffect, useState, useCallback } from "react";
import { ApiError, fetchMe, getToken, setToken, clearToken, logoutRequest, MeUser } from "@/lib/api";
import AuthModal from "@/components/AuthModal";
import { track } from "@/lib/track";
import { identifyUser, resetIdentity } from "@/lib/thirdPartyAnalytics";
import { forgetAllKeys, rememberedKeyCount } from "@/lib/e2e";
import { clearStudioSession } from "@/lib/studioSession";
import { forgetThisDevice } from "@/lib/push";
import { forgetSignedIn, rememberSignedIn } from "@/lib/homeRedirect";
import { Checkbox, ConfirmDialog } from "@/components/ui";

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
  /**
   * Sign out from a "Sign out" button: when this browser keeps encryption keys, first asks whether
   * to forget them too. Resolves false when the person cancelled (still signed in).
   */
  signOut: () => Promise<boolean>;
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
      // No session here: drop a leftover md_si hint so "/" shows the landing page (lib/homeRedirect).
      forgetSignedIn();
      setUser(null);
      setLoading(false);
      return;
    }
    for (let attempt = 0; ; attempt++) {
      try {
        setUser(await fetchMe());
        // A confirmed session (every sign-in path ends here or in login → setToken): "/" now opens
        // the dashboard. Also brings sessions from before the hint existed up to date.
        rememberSignedIn(getToken());
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
    // This browser stops getting the account's push notifications (lib/push; bounded to 2 s).
    await forgetThisDevice();
    await logoutRequest();
    clearToken();
    setUser(null);
    resetIdentity();
    // Markdrop Guides' studio host keeps its own copy of the session (lib/studioSession): it goes too.
    await clearStudioSession();
  }, []);

  // Sign out, offering to forget the encryption keys this browser kept (they never left it, but a
  // shared computer shouldn't keep them after its user leaves).
  const [signOutAsk, setSignOutAsk] = useState<{ count: number; resolve: (go: boolean) => void } | null>(null);
  const [forgetKeys, setForgetKeys] = useState(true);
  const signOut = useCallback(async () => {
    const count = rememberedKeyCount();
    if (count === 0) {
      await logout();
      return true;
    }
    setForgetKeys(true);
    const go = await new Promise<boolean>((resolve) => setSignOutAsk({ count, resolve }));
    return go;
  }, [logout]);

  const updateUser = useCallback((u: MeUser) => setUser(u), []);

  const [authModal, setAuthModal] = useState<AuthModalOptions | null>(null);
  const openAuthModal = useCallback((opts?: AuthModalOptions) => setAuthModal(opts ?? {}), []);

  return (
    <AuthContext.Provider value={{ user, loading, login, logout, signOut, refresh, updateUser, openAuthModal }}>
      {children}
      <ConfirmDialog
        open={!!signOutAsk}
        tone="default"
        title="Sign out of Markdrop?"
        body={
          <Checkbox
            label={`Also forget ${signOutAsk?.count ?? 0} encryption ${signOutAsk?.count === 1 ? "key" : "keys"} saved in this browser`}
            description="Encrypted documents then open here only from their full link."
            checked={forgetKeys}
            onChange={(e) => setForgetKeys(e.target.checked)}
          />
        }
        confirmLabel="Sign out"
        onClose={() => {
          signOutAsk?.resolve(false);
          setSignOutAsk(null);
        }}
        onConfirm={async () => {
          if (forgetKeys) forgetAllKeys();
          await logout();
          signOutAsk?.resolve(true);
          setSignOutAsk(null);
        }}
      />
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
