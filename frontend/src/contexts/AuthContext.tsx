"use client";

import { createContext, useContext, useEffect, useState, useCallback } from "react";
import { fetchMe, getToken, setToken, clearToken, logoutRequest, MeUser } from "@/lib/api";

interface AuthState {
  user: MeUser | null;
  loading: boolean;
  login: (token: string, user?: MeUser) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
  updateUser: (user: MeUser) => void;
}

const AuthContext = createContext<AuthState | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<MeUser | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!getToken()) {
      setUser(null);
      setLoading(false);
      return;
    }
    try {
      setUser(await fetchMe());
    } catch {
      clearToken();
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const login = useCallback(async (token: string, u?: MeUser) => {
    setToken(token);
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
  }, []);

  const updateUser = useCallback((u: MeUser) => setUser(u), []);

  return (
    <AuthContext.Provider value={{ user, loading, login, logout, refresh, updateUser }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
