"use client";

import {
  LimitsResponseSchema,
  ListAlertsResponseSchema,
  ListApprovalsResponseSchema,
  ListMachinesResponseSchema,
  ListProjectsResponseSchema,
  ListSessionsResponseV1Schema,
  UsageSummaryResponseSchema,
} from "@commander/contracts";
import type {
  AlertDto,
  ApprovalDto,
  CommandDto,
  LimitsResponse,
  ListApprovalsResponse,
  ListProjectsResponse,
  MachineDto,
  SessionDto,
  UsageSummaryResponse,
} from "@commander/contracts";
import { isTerminalCommandState } from "@commander/contracts";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { applyAlertPush } from "@/lib/alerts-view";
import { getJson } from "@/lib/client-api";
import { useLiveState } from "@/lib/live-client";
import { filterByVisibleMachines, isHiddenMachine } from "@/lib/machines";
import type { HideRules } from "@/lib/machines";
import { upsertById } from "@/lib/push";
import { addTickToProjects, addTickToSummary } from "@/lib/usage-ticks";
import { useLiveSync } from "@/lib/use-live-sync";

/**
 * Butun dashboard uchun yagona jonli ma'lumot ombori: layout'dagi SSR snapshot + bitta SSE oqimi.
 * Sidebar (sonlar, badge), Umumiy, Sessiyalar, Loyihalar, Mashinalar shu yerdan o'qiydi:
 * sahifalar almashganda qayta yuklanmaydi, hamma joyda bir xil raqamlar.
 */

export interface LiveInitial {
  sessions: SessionDto[];
  machines: MachineDto[];
  approvals: ListApprovalsResponse | null;
  limits: LimitsResponse | null;
  summary: UsageSummaryResponse | null;
  projects: ListProjectsResponse | null;
  /** Ochiq watchdog ogohlantirishlari (bo'lmasa `[]`). */
  alerts?: AlertDto[];
  error: string | null;
}

export interface LiveDataValue {
  /** Faol-oyna sessiyalari (`active=1`), yashirin mashinalarsiz. */
  sessions: SessionDto[];
  /** Ko'rinadigan (yashirilmagan) mashinalar. */
  machines: MachineDto[];
  approvals: ListApprovalsResponse | null;
  limits: LimitsResponse | null;
  summary: UsageSummaryResponse | null;
  projects: ListProjectsResponse | null;
  /** Ochiq watchdog ogohlantirishlari (eng yangisi birinchi). */
  alerts: AlertDto[];
  error: string | null;
  canApprove: boolean;
  /** COMMANDER_CONTROL_TOKEN sozlangan (masofaviy boshqaruv yoqilishi mumkin). */
  canControl: boolean;
  /** Oxirgi ma'lum buyruq holatlari (id bo'yicha): `command.updated` push'lari va yaratilgan buyruqlar. */
  commands: Record<string, CommandDto>;
  trackCommand: (c: CommandDto) => void;
  lockdown: boolean;
  lockdownSince: string | null;
  /** SSE ochiq VA center ko'prigi tayyor. */
  live: boolean;
  hide: HideRules;
  resolveApproval: (a: ApprovalDto) => void;
  refreshApprovals: () => void;
  /** 6.16: arxivlash/qaytarishdan keyin faol loyihalar ro'yxatini qayta o'qish. */
  refreshProjects: () => Promise<void>;
}

const Ctx = createContext<LiveDataValue | null>(null);

export function useLiveData(): LiveDataValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useLiveData: LiveDataProvider topilmadi");
  return v;
}

interface Snapshot {
  sessions: SessionDto[];
  machines: MachineDto[];
  approvals: ListApprovalsResponse;
  limits: LimitsResponse;
  summary: UsageSummaryResponse;
  projects: ListProjectsResponse;
  /** `null` = olib bo'lmadi (xato jiddiy emas, eski ro'yxat qoladi). */
  alerts: AlertDto[] | null;
}

/** Yakuniy holatdagi approval pending'dan olinadi va `recent` boshiga qo'yiladi. */
export function applyResolved(a: ListApprovalsResponse | null, resolved: ApprovalDto): ListApprovalsResponse | null {
  if (!a) return a;
  return {
    pending: a.pending.filter((p) => p.id !== resolved.id),
    recent: upsertById(a.recent, resolved).slice(0, 20),
  };
}

/** Yakuniy holat o'zgarmaydi: kechikkan eski push yakuniy holatni bosib ketmasin. */
export function mergeCommand(m: Record<string, CommandDto>, c: CommandDto): Record<string, CommandDto> {
  const cur = m[c.id];
  if (cur && isTerminalCommandState(cur.status) && !isTerminalCommandState(c.status)) return m;
  return { ...m, [c.id]: c };
}

const POLL_FALLBACK_MS = 20_000;

export function LiveDataProvider({ initial, hide, canApprove, canControl, children }: { initial: LiveInitial; hide: HideRules; canApprove: boolean; canControl: boolean; children: ReactNode }) {
  const [sessions, setSessions] = useState(initial.sessions);
  const [machines, setMachines] = useState(initial.machines);
  const [approvals, setApprovals] = useState(initial.approvals);
  const [limits, setLimits] = useState(initial.limits);
  const [summary, setSummary] = useState(initial.summary);
  const [projects, setProjects] = useState(initial.projects);
  const [alerts, setAlerts] = useState<AlertDto[]>(initial.alerts ?? []);
  const [error, setError] = useState(initial.error);
  const [commands, setCommands] = useState<Record<string, CommandDto>>({});
  const ls = useLiveState();

  const fetchSnapshot = useCallback(async (signal?: AbortSignal): Promise<Snapshot> => {
    const [s, m, a, l, u, p, al] = await Promise.all([
      getJson("/sessions?limit=500&active=1", ListSessionsResponseV1Schema, signal),
      getJson("/machines", ListMachinesResponseSchema, signal),
      getJson("/approvals?recentLimit=10", ListApprovalsResponseSchema, signal),
      getJson("/limits", LimitsResponseSchema, signal),
      getJson("/usage/summary", UsageSummaryResponseSchema, signal),
      getJson("/projects?limit=500", ListProjectsResponseSchema, signal),
      // Ogohlantirishlar muhim emas: xato bo'lsa butun snapshot buzilmasin
      getJson("/alerts?state=open&limit=50", ListAlertsResponseSchema, signal).catch(() => null),
    ]);
    return { sessions: s.items, machines: m.items, approvals: a, limits: l, summary: u, projects: p, alerts: al ? al.items : null };
  }, []);

  const apply = useCallback((d: Snapshot) => {
    setSessions(d.sessions);
    setMachines(d.machines);
    setApprovals(d.approvals);
    setLimits(d.limits);
    setSummary(d.summary);
    setProjects(d.projects);
    if (d.alerts) setAlerts(d.alerts);
    setError(null);
  }, []);

  useLiveSync<Snapshot>({
    fetchSnapshot,
    onSnapshot: apply,
    onError: setError,
    onPush: (e) => {
      switch (e.type) {
        case "session.updated":
          setSessions((l) => upsertById(l, e.session));
          break;
        case "machine.updated":
          setMachines((l) => upsertById(l, e.machine));
          break;
        case "limits.updated":
          setLimits(e.limits);
          break;
        case "usage.tick":
          setSummary((s) => (s ? addTickToSummary(s, e.tick.total) : s));
          setProjects((p) => (p ? addTickToProjects(p, e.tick.byProject, new Date().toISOString()) : p));
          break;
        case "approval.created":
          setApprovals((a) => (a ? { ...a, pending: upsertById(a.pending, e.approval) } : a));
          break;
        case "approval.resolved":
          setApprovals((a) => applyResolved(a, e.approval));
          break;
        case "command.updated":
          setCommands((m) => mergeCommand(m, e.command));
          break;
        case "alert.created":
        case "alert.updated":
          setAlerts((l) => applyAlertPush(l, e.alert));
          break;
      }
    },
  });

  // SSE ko'prigi tayyor bo'lmasa (center ishlamayapti / qayta ulanmoqda): kamdan-kam REST so'rov.
  const readyRef = useRef(ls.ready);
  useEffect(() => {
    readyRef.current = ls.ready;
  }, [ls.ready]);
  useEffect(() => {
    const t = setInterval(() => {
      if (readyRef.current) return;
      fetchSnapshot()
        .then(apply)
        .catch((e: unknown) => setError(e instanceof Error ? e.message : "Xatolik"));
    }, POLL_FALLBACK_MS);
    return () => clearInterval(t);
  }, [fetchSnapshot, apply]);

  const trackCommand = useCallback((c: CommandDto) => setCommands((m) => mergeCommand(m, c)), []);
  const resolveApproval = useCallback((a: ApprovalDto) => setApprovals((x) => applyResolved(x, a)), []);
  const refreshApprovals = useCallback(() => {
    getJson("/approvals?recentLimit=10", ListApprovalsResponseSchema)
      .then(setApprovals)
      .catch(() => undefined);
  }, []);

  const refreshProjects = useCallback(async () => {
    setProjects(await getJson("/projects?limit=500", ListProjectsResponseSchema));
  }, []);

  const visibleMachines = useMemo(() => machines.filter((m) => !isHiddenMachine(m, hide)), [machines, hide]);
  // Faqat ko'rinadigan mashinalar sessiyalari/ogohlantirishlari: yashirin va markaz ro'yxatida yo'q (retired/merged) mashinalarniki
  // ko'rsatilmaydi (ma'lumot o'chirilmaydi). Mashinalar ro'yxati bo'sh bo'lsa (hali yuklanmagan/xato) filtrlanmaydi.
  const visibleSessions = useMemo(() => filterByVisibleMachines(sessions, visibleMachines, machines.length > 0), [sessions, visibleMachines, machines.length]);
  const visibleAlerts = useMemo(() => filterByVisibleMachines(alerts, visibleMachines, machines.length > 0), [alerts, visibleMachines, machines.length]);

  const value = useMemo<LiveDataValue>(
    () => ({
      sessions: visibleSessions,
      machines: visibleMachines,
      approvals,
      limits,
      summary,
      projects,
      alerts: visibleAlerts,
      error,
      canApprove,
      canControl,
      commands,
      trackCommand,
      lockdown: ls.lockdown?.enabled === true,
      lockdownSince: ls.lockdown?.since ?? null,
      live: ls.sse && ls.ready,
      hide,
      resolveApproval,
      refreshApprovals,
      refreshProjects,
    }),
    [visibleSessions, visibleMachines, approvals, limits, summary, projects, visibleAlerts, error, canApprove, canControl, commands, trackCommand, ls.lockdown, ls.sse, ls.ready, hide, resolveApproval, refreshApprovals, refreshProjects],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
