"use client";

import { ListTasksResponseSchema } from "@commander/contracts";
import type { ListTasksResponse } from "@commander/contracts";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { AlertsCard } from "@/components/alerts/AlertsCard";
import { ApprovalCard } from "@/components/ApprovalCard";
import { BudgetCard } from "@/components/budgets/BudgetBar";
import { useLiveData } from "@/components/LiveData";
import { LimitsCard } from "@/components/LimitsCard";
import { MachineCard } from "@/components/MachineCard";
import { HealthStrip } from "@/components/machines/HealthStrip";
import { CenterHealthCard } from "@/components/overview/CenterHealthCard";
import { CommandReviewPanel } from "@/components/overview/CommandReviewPanel";
import { NewSessionButton } from "@/components/shell/NewSessionButton";
import { LivePill, LockdownPill, PageHeader, SearchBox } from "@/components/ui/PageHeader";
import { ApiErrorBar, EmptyState } from "@/components/ui/States";
import { StatusPill } from "@/components/ui/StatusPill";
import { getJson } from "@/lib/client-api";
import { useBudgets } from "@/lib/use-budgets";
import { formatCompact, formatCost, formatCount, formatTokens } from "@/lib/format";
import { machineLabel, shortMachineName } from "@/lib/machines";
import { activeSessions } from "@/lib/session-list";
import { displayStatus } from "@/lib/status";
import { topProjectsToday } from "@/lib/projects-view";
import { useNow } from "@/lib/use-now";

const SETTLE_MS = 10_000;

export function OverviewView() {
  const { sessions, machines, approvals, limits, summary, projects, error } = useLiveData();
  const now = useNow();
  const router = useRouter();
  const budgets = useBudgets().data;
  const [q, setQ] = useState("");
  const [todayTasks, setTodayTasks] = useState<ListTasksResponse | null>(null);
  const todayStart = projects?.todayStart ?? null;

  // "Bugungi vazifalar": bugun faollik bo'lgan vazifalar (1 daqiqada bir yangilanadi)
  useEffect(() => {
    if (!todayStart) return;
    const ctl = new AbortController();
    const load = () =>
      getJson(`/tasks?${new URLSearchParams({ from: todayStart, to: new Date().toISOString(), limit: "50" })}`, ListTasksResponseSchema, ctl.signal)
        .then(setTodayTasks)
        .catch(() => undefined);
    void load();
    const t = setInterval(load, 60_000);
    return () => {
      ctl.abort();
      clearInterval(t);
    };
  }, [todayStart]);
  const topTasks = useMemo(
    () =>
      [...(todayTasks?.items ?? [])]
        .filter((t) => t.stats.tokens.totalTokens > 0)
        .sort((a, b) => b.stats.tokens.totalTokens - a.stats.tokens.totalTokens)
        .slice(0, 5),
    [todayTasks],
  );
  const topTaskMax = topTasks[0]?.stats.tokens.totalTokens ?? 1;

  const active = useMemo(() => activeSessions(sessions, now), [sessions, now]);
  const waiting = active.filter((s) => s.status === "waiting" && displayStatus(s) !== "stale");
  const pending = approvals?.pending ?? [];
  // Hal qilingan karta darrov yo'qolmasin: 10 soniya xiralashib ko'rinadi
  const settled = (approvals?.recent ?? []).filter((a) => a.status !== "pending" && now > 0 && now - Date.parse(a.resolvedAt ?? a.decidedAt ?? a.requestedAt) < SETTLE_MS);
  const approvalRows = [...pending, ...settled.filter((s) => !pending.some((p) => p.id === s.id))];

  const online = machines.filter((m) => m.online).length;
  // 6.16: arxivlangan loyihalar tokenlari jamiga kiradi, reytingda "Boshqalar" qatori bo'lib qoladi
  const topProjects = useMemo(() => topProjectsToday(projects?.items ?? [], projects?.archived), [projects]);
  const topMax = topProjects[0]?.tokens ?? 1;
  const machineName = useMemo(() => new Map(machines.map((m) => [m.id, machineLabel(m)])), [machines]);

  const attentionBits = [pending.length > 0 && `${pending.length} ta ruxsat so'rovi`, waiting.length > 0 && `${waiting.length} ta sessiya javob kutmoqda`].filter(Boolean);
  const hasAttention = approvalRows.length > 0 || waiting.length > 0;

  return (
    <>
      <PageHeader title="Umumiy">
        <SearchBox
          value={q}
          onChange={setQ}
          placeholder="Sessiya, loyiha, mashina…"
          label="Qidiruv"
          onSubmit={() => router.push(q.trim() ? `/sessions?q=${encodeURIComponent(q.trim())}` : "/sessions")}
        />
        <LivePill />
        <LockdownPill />
        <NewSessionButton />
      </PageHeader>

      <div className="flex w-full max-w-[1360px] flex-col gap-5 p-4 md:p-6">
        <ApiErrorBar error={error} />
        <HealthStrip />
        <CenterHealthCard />

        <AlertsCard />
        <CommandReviewPanel />
        {budgets && budgets.items.length > 0 ? <BudgetCard title="Kunlik byudjetlar" items={budgets.items} resetsAt={budgets.resetsAt} now={now} /> : null}

        {hasAttention ? (
          <section className="card overflow-hidden border-org" aria-label="Diqqat talab qiladi">
            <div className="flex flex-wrap items-center gap-2.5 bg-org-bg px-4 py-3">
              <span className="dot live text-org" />
              <h2 className="m-0 text-sm font-semibold">Diqqat talab qiladi</h2>
              <span className="text-mu">{attentionBits.join(" · ") || "Ruxsat so'rovlari hal qilindi"}</span>
            </div>
            {approvalRows.map((a) => (
              <ApprovalCard key={a.id} approval={a} variant="row" />
            ))}
            {waiting.map((s) => (
              <Link key={s.id} href={`/sessions/${s.id}`} className="row" style={{ padding: "14px 16px" }}>
                <StatusPill status="waiting" />
                <span className="font-semibold">{s.projectName}</span>
                <span className="mono text-mu">{shortMachineName(s.machineName)}</span>
                <span className="min-w-0 flex-1 truncate text-mu">{s.message ? `“${s.message}”` : "Javob kutmoqda"}</span>
                <span className="mono text-mu" suppressHydrationWarning>
                  {now ? formatCompact(now - Date.parse(s.statusSince)) : ""}
                </span>
                <span className="font-medium text-blue">Javob berish →</span>
              </Link>
            ))}
          </section>
        ) : (
          <section className="card flex items-center gap-2.5 px-4 py-3" aria-label="Diqqat talab qiladi">
            <span className="dot text-grn" />
            <h2 className="m-0 text-sm font-semibold">Diqqat talab qiladi</h2>
            <span className="text-mu">Hozir ruxsat yoki javob kutayotgan narsa yo&apos;q</span>
          </section>
        )}

        <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,420px),1fr))] gap-5">
          <section className="card flex flex-col gap-4 p-4" aria-label="Limitlar">
            <div className="flex items-center justify-between">
              <h2 className="m-0 text-sm font-semibold">Limitlar</h2>
            </div>
            {limits ? <LimitsCard fiveHour={limits.fiveHour} sevenDay={limits.sevenDay} now={now} pace={limits.pace ?? null} /> : <span className="text-mu">Limit ma&apos;lumoti olinmadi.</span>}
          </section>

          <section className="card flex flex-col gap-3.5 p-4" aria-label="Tokenlar">
            <div className="flex items-center justify-between">
              <h2 className="m-0 text-sm font-semibold">Tokenlar</h2>
              <Link href="/tokens" className="text-xs">
                Analitika →
              </Link>
            </div>
            {summary ? (
              <>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  {[
                    { label: "Bugun", p: summary.today },
                    { label: "7 kun", p: summary.last7d },
                    { label: "30 kun", p: summary.last30d },
                    { label: "Jami", p: summary.allTime },
                  ].map(({ label, p }) => (
                    <div key={label} className="flex flex-col gap-1 rounded-lg bg-s2 px-3 py-2.5">
                      <span className="lbl">{label}</span>
                      <span className="mono text-[22px] font-semibold" title={`${formatCount(p.totals.totalTokens)} token`}>
                        {formatTokens(p.totals.totalTokens)}
                      </span>
                      <span className="text-xs text-mu">{formatCount(p.totals.requests)} so&apos;rov</span>
                      <span className="text-[11px] text-fa" title="Obuna uchun haqiqiy to'lov emas">
                        {p.totals.costUsd === null ? "API ekv.: narx yo'q" : `≈ ${formatCost(p.totals.costUsd)} API ekv.`}
                      </span>
                    </div>
                  ))}
                </div>
                <span className="text-xs text-mu">
                  Bugun: cache read {formatTokens(summary.today.totals.cacheReadTokens)} · output {formatTokens(summary.today.totals.outputTokens)} · input {formatTokens(summary.today.totals.inputTokens)} · cache write{" "}
                  {formatTokens(summary.today.totals.cacheCreationTokens)}
                </span>
              </>
            ) : (
              <span className="text-mu">Sarf ma&apos;lumoti olinmadi.</span>
            )}
          </section>
        </div>

        <section className="flex flex-col gap-2.5" aria-label="Mashinalar">
          <div className="flex items-center justify-between">
            <h2 className="m-0 text-sm font-semibold">
              Mashinalar{" "}
              <span className="font-normal text-mu">
                {online} onlayn · {machines.length - online} oflayn
              </span>
            </h2>
            <Link href="/machines" className="text-xs">
              Hammasi →
            </Link>
          </div>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-2.5">
            {machines.map((m) => (
              <MachineCard key={m.id} machine={m} now={now} />
            ))}
            {machines.length === 0 && <span className="text-mu">Mashina yo&apos;q.</span>}
          </div>
        </section>

        <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,420px),1fr))] items-start gap-5">
          <section className="card overflow-hidden" aria-label="Aktiv sessiyalar">
            <div className="flex items-center justify-between px-4 py-3">
              <h2 className="m-0 text-sm font-semibold">
                Aktiv sessiyalar <span className="font-normal text-mu">{active.length}</span>
              </h2>
              <Link href="/sessions" className="text-xs">
                Hammasi →
              </Link>
            </div>
            {active.length === 0 ? (
              <div className="border-t border-bd p-4">
                <EmptyState title="Sessiya yo'q" action={<NewSessionButton />}>
                  Hozir hech bir mashinada Claude ishlamayapti.
                </EmptyState>
              </div>
            ) : (
              active.slice(0, 6).map((s) => (
                <Link key={s.id} href={`/sessions/${s.id}`} className="row">
                  <StatusPill status={displayStatus(s)} className="w-[132px] shrink-0" />
                  <span className="w-[140px] shrink-0 truncate font-semibold">{s.projectName}</span>
                  <span className="mono min-w-0 flex-1 truncate text-mu">{shortMachineName(s.machineName)}</span>
                  <span className="mono text-mu" suppressHydrationWarning>
                    {now ? formatCompact(now - Date.parse(s.statusSince)) : ""}
                  </span>
                </Link>
              ))
            )}
          </section>

          {topTasks.length > 0 && (
            <section className="card flex flex-col gap-3 p-4 lg:col-span-2" aria-label="Bugungi vazifalar">
              <h2 className="m-0 text-sm font-semibold">Bugungi vazifalar</h2>
              {topTasks.map((t) => (
                <Link key={`${t.projectId}-${t.taskKey}`} href={`/projects/${t.projectId}`} className="flex flex-col gap-[5px] text-tx hover:no-underline">
                  <div className="flex justify-between gap-2">
                    <span className="min-w-0 truncate">
                      <span className="mono text-mu">{t.taskKey}</span> <span className="font-medium">{t.title ?? "Vazifa"}</span> <span className="text-mu">· {t.projectName}</span>
                      {t.stats.source === "branch" && <span className="ml-1.5 text-[10px] text-fa">taxmin (branch)</span>}
                    </span>
                    <span className="mono shrink-0 text-mu">{formatTokens(t.stats.tokens.totalTokens)}</span>
                  </div>
                  <div className="h-2 rounded bg-s3">
                    <div className="h-2 rounded bg-blue" style={{ width: `${Math.max(2, (t.stats.tokens.totalTokens / topTaskMax) * 100)}%` }} />
                  </div>
                </Link>
              ))}
            </section>
          )}

          <section className="card flex flex-col gap-3 p-4" aria-label="Bugungi tokenlar">
            <div className="flex items-center justify-between">
              <h2 className="m-0 text-sm font-semibold">Bugungi tokenlar · loyiha bo&apos;yicha</h2>
              <Link href="/projects" className="text-xs">
                Loyihalar →
              </Link>
            </div>
            {topProjects.length === 0 && <span className="text-mu">Bugun hali token sarflanmagan.</span>}
            {topProjects.map((p) => {
              const body = (
                <>
                  <div className="flex justify-between gap-2">
                    <span className="truncate font-medium">{p.name}</span>
                    <span className="mono shrink-0 text-mu">
                      {formatTokens(p.tokens)} · {formatCount(p.requests)} so&apos;rov
                    </span>
                  </div>
                  <div className="h-2 rounded bg-s3">
                    <div className="h-2 rounded bg-blue" style={{ width: `${Math.max(2, (p.tokens / topMax) * 100)}%` }} />
                  </div>
                </>
              );
              return p.projectId ? (
                <Link key={p.key} href={`/projects/${p.projectId}`} className="flex flex-col gap-[5px] text-tx hover:no-underline" title={p.machineId ? machineName.get(p.machineId) : undefined}>
                  {body}
                </Link>
              ) : (
                <div key={p.key} className="flex flex-col gap-[5px]" data-testid="top-projects-others" title="Arxivlangan loyihalar: tokenlar jamiga kiradi">
                  {body}
                </div>
              );
            })}
          </section>
        </div>
      </div>
    </>
  );
}
