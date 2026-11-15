"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { apiFetch, fetchSession, registerReauthHandler, setCsrf } from "@/lib/auth-client";
import type { SessionInfo } from "@/lib/auth-client";
import { ReauthDialog } from "./ReauthDialog";

interface AuthCtx {
  session: SessionInfo | null;
  logout: () => Promise<void>;
}

const Ctx = createContext<AuthCtx>({ session: null, logout: async () => {} });
export const useAuth = (): AuthCtx => useContext(Ctx);

const POLL_MS = 60_000;
const PING_MS = 60_000;

/**
 * Sessiya holati, faoliyat "ping"i (idle taymeri) va xavfli amal uchun qayta tasdiqlash oynasi.
 * `apiFetch` `reauth_required` olsa shu yerdagi oyna ochiladi va tasdiqlangach so'rov qayta yuboriladi.
 */
export function AuthProvider({ initial, children }: { initial: SessionInfo; children: ReactNode }) {
  const [session, setSession] = useState<SessionInfo | null>(initial);
  const [reauthOpen, setReauthOpen] = useState(false);
  const pending = useRef<{ promise: Promise<boolean>; resolve: (ok: boolean) => void } | null>(null);
  const lastPing = useRef(0);

  const refresh = useCallback(async () => {
    const s = await fetchSession();
    if (s) setSession(s);
    else {
      setSession(null);
      setCsrf(null);
      window.location.replace("/login");
    }
  }, []);

  useEffect(() => {
    setCsrf(initial.csrf);
    const t = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(t);
  }, [refresh, initial.csrf]);

  // Haqiqiy faoliyat (bosish/klaviatura): idle taymerini yangilaydi (daqiqada ko'pi bilan bir marta).
  useEffect(() => {
    const onActivity = () => {
      const now = Date.now();
      if (now - lastPing.current < PING_MS) return;
      lastPing.current = now;
      void apiFetch("/api/auth/ping", { method: "POST" });
    };
    window.addEventListener("pointerdown", onActivity, { passive: true });
    window.addEventListener("keydown", onActivity);
    return () => {
      window.removeEventListener("pointerdown", onActivity);
      window.removeEventListener("keydown", onActivity);
    };
  }, []);

  useEffect(() => {
    registerReauthHandler(() => {
      if (pending.current) return pending.current.promise;
      let resolve: (ok: boolean) => void = () => {};
      const promise = new Promise<boolean>((r) => {
        resolve = r;
      });
      pending.current = { promise, resolve };
      setReauthOpen(true);
      return promise;
    });
    return () => registerReauthHandler(null);
  }, []);

  const finishReauth = useCallback(
    (ok: boolean) => {
      setReauthOpen(false);
      pending.current?.resolve(ok);
      pending.current = null;
      if (ok) void refresh();
    },
    [refresh],
  );

  const logout = useCallback(async () => {
    await apiFetch("/api/auth/logout", { method: "POST" });
    setCsrf(null);
    window.location.replace("/login");
  }, []);

  const value = useMemo(() => ({ session, logout }), [session, logout]);
  return (
    <Ctx.Provider value={value}>
      {children}
      {reauthOpen && <ReauthDialog methods={session?.methods ?? { passkey: false, password: true, app: false }} onDone={finishReauth} />}
    </Ctx.Provider>
  );
}
