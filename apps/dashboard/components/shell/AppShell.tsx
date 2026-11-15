"use client";

import type { ReactNode } from "react";
import { LiveDataProvider } from "@/components/LiveData";
import type { LiveInitial } from "@/components/LiveData";
import type { HideRules } from "@/lib/machines";
import { IconClose, IconMenu } from "@/components/ui/icons";
import { KeyboardShortcuts } from "./KeyboardShortcuts";
import { LockdownBanner } from "./LockdownBanner";
import { NavWatchdog } from "./NavWatchdog";
import { NewSessionModal } from "./NewSessionModal";
import { Logo, SidebarContent } from "./Sidebar";
import { ShellUiProvider, useShellUi } from "./ShellUi";

/** Ilova qobig'i: sidebar (≥md qotirilgan, tor ekranda ochiladigan panel), lockdown banner, yorliqlar. */
export function AppShell({ initial, hide, canApprove, canControl, children }: { initial: LiveInitial; hide: HideRules; canApprove: boolean; canControl: boolean; children: ReactNode }) {
  return (
    <LiveDataProvider initial={initial} hide={hide} canApprove={canApprove} canControl={canControl}>
      <ShellUiProvider>
        <Frame>{children}</Frame>
        <NewSessionModal />
        <KeyboardShortcuts />
        <NavWatchdog />
      </ShellUiProvider>
    </LiveDataProvider>
  );
}

function Frame({ children }: { children: ReactNode }) {
  const { drawerOpen, setDrawerOpen } = useShellUi();
  return (
    <div className="flex min-h-screen items-stretch">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-s1 focus:px-3 focus:py-2">
        Asosiy kontentga o&apos;tish
      </a>
      <aside className="sticky top-0 hidden h-screen w-[232px] shrink-0 flex-col gap-1 overflow-y-auto border-r border-bd bg-s1 px-3 py-4 md:flex">
        <SidebarContent />
      </aside>

      {drawerOpen && (
        <div className="fixed inset-0 z-40 md:hidden" onKeyDown={(e) => e.key === "Escape" && setDrawerOpen(false)}>
          <div className="absolute inset-0 bg-scrim" onClick={() => setDrawerOpen(false)} aria-hidden="true" />
          <aside id="mobile-nav" className="absolute inset-y-0 left-0 flex w-[260px] flex-col gap-1 overflow-y-auto border-r border-bd bg-s1 px-3 py-4" aria-label="Navigatsiya">
            <button type="button" aria-label="Yopish" onClick={() => setDrawerOpen(false)} className="absolute right-2 top-3 border-0 bg-transparent p-1 text-mu" style={{ cursor: "pointer" }}>
              <IconClose size={18} />
            </button>
            <SidebarContent onNavigate={() => setDrawerOpen(false)} />
          </aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-2 border-b border-bd bg-s1 px-3 py-2 md:hidden">
          <button type="button" aria-label="Menyuni ochish" aria-expanded={drawerOpen} aria-controls="mobile-nav" onClick={() => setDrawerOpen(true)} className="flex border-0 bg-transparent p-1 text-tx" style={{ cursor: "pointer" }}>
            <IconMenu size={20} />
          </button>
          <div className="-mb-3 -mt-1">
            <Logo />
          </div>
        </div>
        <LockdownBanner />
        <main id="main" className="flex min-w-0 flex-1 flex-col">
          {children}
        </main>
      </div>
    </div>
  );
}
