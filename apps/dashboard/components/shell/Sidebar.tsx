"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { useLiveData } from "@/components/LiveData";
import { IconAlert, IconBars, IconClock, IconFolder, IconGrid, IconSearch, IconServers, IconTerminal } from "@/components/ui/icons";
import { formatWeekdayClock } from "@/lib/format";
import { LIMIT_COLOR_VAR, describeLimitDisplay } from "@/lib/limits-view";
import { useNow } from "@/lib/use-now";
import { LogoutButton } from "@/components/auth/LogoutButton";
import { ThemeToggle } from "./ThemeToggle";

interface Item {
  href: string;
  label: string;
  icon: ReactNode;
  /** Chap tomondagi turtki belgisi (masalan kutayotgan ruxsatlar). */
  badge?: number;
  /** O'ng tomondagi moviy-kulrang son. */
  count?: string;
}

function isActive(pathname: string, href: string): boolean {
  return href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
}

export function Logo() {
  return (
    <div className="flex items-center gap-2.5 px-2 pb-4 pt-1">
      <svg width="26" height="26" viewBox="0 0 26 26" aria-hidden="true">
        <rect width="26" height="26" rx="7" fill="#FF7A45" />
        <path d="M8 9l4 4-4 4M14 17h5" stroke="#fff" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span className="text-[15px] font-bold">Commander</span>
    </div>
  );
}

/** Chap panel: navigatsiya (jonli sonlar), haftalik limit, mavzu. */
export function SidebarContent({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  const { sessions, approvals, projects, machines, limits, alerts } = useLiveData();
  const now = useNow();
  const pending = approvals?.pending.length ?? 0;
  const online = machines.filter((m) => m.online).length;

  const items: Item[] = [
    { href: "/", label: "Umumiy", icon: <IconGrid /> },
    { href: "/sessions", label: "Sessiyalar", icon: <IconTerminal />, badge: pending, count: String(sessions.length) },
    { href: "/projects", label: "Loyihalar", icon: <IconFolder />, count: projects ? String(projects.items.length) : undefined },
    { href: "/search", label: "Qidiruv", icon: <IconSearch /> },
    { href: "/queue", label: "Navbat", icon: <IconClock /> },
    { href: "/templates", label: "Shablonlar", icon: <IconBars /> },
    { href: "/tokens", label: "Tokenlar", icon: <IconBars /> },
    { href: "/machines", label: "Mashinalar", icon: <IconServers />, count: `${online}/${machines.length}` },
    { href: "/alerts", label: "Ogohlantirishlar", icon: <IconAlert />, count: alerts.length > 0 ? String(alerts.length) : undefined },
    { href: "/reports", label: "Hisobotlar", icon: <IconBars /> },
    { href: "/billing", label: "Hisob-kitob", icon: <IconBars /> },
    { href: "/security", label: "Xavfsizlik", icon: <IconAlert /> },
    { href: "/budgets", label: "Byudjetlar", icon: <IconBars /> },
    { href: "/settings", label: "Umumiy sozlamalar", icon: <IconBars /> },
    { href: "/settings-sync", label: "Sozlamalar", icon: <IconServers /> },
    { href: "/help", label: "Yo'riqnoma", icon: <IconSearch /> },
  ];

  const week = describeLimitDisplay(limits?.sevenDay ?? null, now);
  const weekReset = limits?.sevenDay?.resetsAt ? Date.parse(limits.sevenDay.resetsAt) : NaN;

  return (
    <>
      <Logo />
      <nav aria-label="Asosiy" className="flex flex-col gap-1">
        {items.map((it) => {
          const on = isActive(pathname, it.href);
          return (
            <Link key={it.href} href={it.href} className={`nav ${on ? "on" : ""}`} aria-current={on ? "page" : undefined} onClick={onNavigate}>
              {it.icon}
              <span className="flex-1">{it.label}</span>
              {it.badge ? (
                <span className="pill bg-org text-white" style={{ height: 18, padding: "0 6px", fontSize: 11 }} title={`${it.badge} ta ruxsat so'rovi kutmoqda`} aria-label={`${it.badge} ta ruxsat so'rovi kutmoqda`}>
                  {it.badge}
                </span>
              ) : null}
              {it.count !== undefined && <span className="mono text-xs text-mu">{it.count}</span>}
            </Link>
          );
        })}
      </nav>
      <div className="flex-1" />
      <div className="card flex flex-col gap-1.5 bg-s2 px-3 py-2.5" data-testid="sidebar-limit">
        <span className="lbl">Haftalik limit</span>
        <div className="flex items-baseline justify-between">
          <span className="mono text-base font-semibold" style={{ color: LIMIT_COLOR_VAR[week.valueColor] }}>
            {week.valueText}
          </span>
          <span className="text-[11px] text-mu" suppressHydrationWarning>
            {Number.isNaN(weekReset) ? "" : formatWeekdayClock(weekReset)}
          </span>
        </div>
        <div className="h-1 rounded bg-s3">
          <div className={`h-1 rounded ${week.barKind === "hatch" ? "hatch" : ""}`} style={{ width: `${week.barPct}%`, background: week.barKind === "hatch" ? undefined : LIMIT_COLOR_VAR[week.barColor] }} />
        </div>
        {week.tag?.dashed && <span className="text-[11px] text-fa">taxmin</span>}
      </div>
      <ThemeToggle />
      <LogoutButton />
    </>
  );
}
