"use client";

import { createContext, useCallback, useContext, useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { RemotePermissionMode } from "@commander/contracts";

/** Qobiq holati: "Yangi sessiya" oynasi va tor ekrandagi sidebar. */
export interface NewSessionPrefill {
  machineId: string;
  cwd: string;
  /** Vazifa matni oldindan (masalan `#task:2.15 sarlavha`). */
  prompt?: string;
  /** Ruxsat rejimi oldindan (masalan loglardan so'rash: `plan`); mashina qo'llamasa `default`. */
  permissionMode?: RemotePermissionMode;
}

interface ShellUiValue {
  newSessionOpen: boolean;
  /** Oldindan to'ldirilgan mashina va papka (loyihadan ochilganda). */
  newSessionPrefill: NewSessionPrefill | null;
  openNewSession: (prefill?: NewSessionPrefill) => void;
  closeNewSession: () => void;
  drawerOpen: boolean;
  setDrawerOpen: (v: boolean) => void;
}

const Ctx = createContext<ShellUiValue | null>(null);

export function ShellUiProvider({ children }: { children: ReactNode }) {
  const [newSessionOpen, setNewSessionOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [newSessionPrefill, setPrefill] = useState<NewSessionPrefill | null>(null);
  const openNewSession = useCallback((prefill?: NewSessionPrefill) => {
    setPrefill(prefill ?? null);
    setNewSessionOpen(true);
  }, []);
  const closeNewSession = useCallback(() => {
    setNewSessionOpen(false);
    setPrefill(null);
  }, []);
  const value = useMemo(
    () => ({ newSessionOpen, newSessionPrefill, openNewSession, closeNewSession, drawerOpen, setDrawerOpen }),
    [newSessionOpen, newSessionPrefill, openNewSession, closeNewSession, drawerOpen],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useShellUi(): ShellUiValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useShellUi: ShellUiProvider topilmadi");
  return v;
}
