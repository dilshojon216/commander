"use client";

import type { HealthRange, HealthSnapshot } from "@commander/contracts";
import Link from "next/link";
import { useState } from "react";
import { InvestigateControl, investigationSettingsHref } from "@/components/investigations/InvestigateControl";
import { InvestigationSettingsForm } from "@/components/investigations/InvestigationSettingsForm";
import { useLiveData } from "@/components/LiveData";
import { BudgetBar } from "@/components/budgets/BudgetBar";
import { LogsPanel } from "@/components/logs/LogsPanel";
import { LivePill, PageHeader } from "@/components/ui/PageHeader";
import { ApiErrorBar } from "@/components/ui/States";
import { formatDuration } from "@/lib/format";
import { HEALTH_RANGES, formatBytes, formatPct, incidentTitle, memPct } from "@/lib/health-view";
import { canInvestigateIncident } from "@/lib/investigation-view";
import { machineLabel } from "@/lib/machines";
import { findBudget } from "@/lib/budgets-view";
import { useBudgets } from "@/lib/use-budgets";
import { useInvestigations } from "@/lib/use-investigations";
import { useMachineHealth } from "@/lib/use-health";
import { useNow } from "@/lib/use-now";
import { ContainerList, FailedUnits, HealthBar, HealthStatusPill, Sparkline } from "./HealthParts";

const RANGE_MS: Record<HealthRange, number> = { "6h": 6 * 3_600_000, "24h": 24 * 3_600_000, "7d": 7 * 24 * 3_600_000 };

/** `/machines/[id]`: salomatlik grafiklari (6s/24s/7k), disklar, jarayonlar, konteynerlar va hodisalar. */
export function MachineDetailView({ machineId }: { machineId: string }) {
  const [range, setRange] = useState<HealthRange>("24h");
  const { data, live, error } = useMachineHealth(machineId, range);
  const { machines, canControl, lockdown } = useLiveData();
  const [tab, setTab] = useState<"status" | "logs">("status");
  const investigations = useInvestigations({ machineId, kind: "health" });
  const now = useNow();
  const budgets = useBudgets().data;
  const machineBudget = budgets ? findBudget(budgets.items, "machine", machineId) : null;
  const machine = machines.find((m) => m.id === machineId);
  const title = machine ? machineLabel(machine) : "Mashina";
  const snapshot: HealthSnapshot | null = live?.snapshot ?? data?.latest ?? null;
  const status = live?.status ?? data?.status ?? "unknown";
  const to = data?.receivedAt ? Date.parse(data.receivedAt) : (now ?? 0);
  const from = to - RANGE_MS[range];

  return (
    <>
      <PageHeader title={title} count="Server holati">
        <LivePill />
      </PageHeader>
      <div className="flex flex-col gap-3.5 px-4 py-5 md:px-6">
        <Link href="/machines" className="text-xs text-blue hover:underline">
          ← Mashinalar
        </Link>
        <ApiErrorBar error={error} />
        {machineBudget && budgets ? (
          <section className="card p-4" aria-label="Kunlik byudjet">
            <BudgetBar status={machineBudget} label="Kunlik byudjet (mashina)" resetsAt={budgets.resetsAt} now={now} />
          </section>
        ) : null}
        <div className="flex gap-1" role="tablist" aria-label="Bo'limlar">
          {([["status", "Holat"], ["logs", "Loglar"]] as const).map(([k, label]) => (
            <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k)} className={`pill ${tab === k ? "bg-blue-bg text-blue" : "bg-gray-bg text-mu"}`} data-testid={`tab-${k}`}>
              {label}
            </button>
          ))}
        </div>
        {tab === "logs" ? <LogsPanel machineId={machineId} containers={snapshot?.docker?.containers ?? []} failedUnits={snapshot?.systemd?.failed ?? []} /> : null}
        <div className={tab === "status" ? "contents" : "hidden"}>

        <div className="card flex flex-wrap items-center justify-between gap-3 p-4">
          <div className="flex items-center gap-3">
            <HealthStatusPill status={status} />
            {snapshot ? (
              <span className="mono text-xs text-mu" suppressHydrationWarning>
                uptime {formatDuration(snapshot.uptimeSec * 1000)} · {snapshot.platform}
              </span>
            ) : null}
          </div>
          <div className="flex gap-1" role="group" aria-label="Davr">
            {HEALTH_RANGES.map((r) => (
              <button key={r.key} type="button" onClick={() => setRange(r.key)} className={`pill ${range === r.key ? "bg-blue-bg text-blue" : "bg-gray-bg text-mu"}`} aria-pressed={range === r.key} data-testid={`range-${r.key}`}>
                {r.label}
              </button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,320px),1fr))] gap-3.5">
          <ChartCard title="CPU" value={formatPct(snapshot?.cpu.pct ?? null)}>
            <Sparkline series={data?.series ?? []} pick={(p) => p.cpu} label={`CPU, ${range}`} height={90} fromTs={from} toTs={to} />
          </ChartCard>
          <ChartCard title="RAM" value={formatPct(snapshot ? memPct(snapshot) : null)}>
            <Sparkline series={data?.series ?? []} pick={(p) => p.memPct} label={`RAM, ${range}`} height={90} color="var(--org)" fromTs={from} toTs={to} />
          </ChartCard>
          <ChartCard title="Disk (eng to'lgani)" value={formatPct(snapshot ? Math.max(0, ...snapshot.disks.map((d) => d.pct)) : null)}>
            <Sparkline series={data?.series ?? []} pick={(p) => p.diskMaxPct} label={`Disk, ${range}`} height={90} color="var(--grn)" fromTs={from} toTs={to} />
          </ChartCard>
        </div>

        {snapshot ? (
          <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,320px),1fr))] gap-3.5">
            <section className="card flex flex-col gap-2.5 p-4" aria-label="Disklar">
              <h3 className="text-sm font-semibold">Disklar</h3>
              {snapshot.disks.length === 0 ? <div className="text-xs text-fa">Ma&apos;lumot yo&apos;q</div> : null}
              {snapshot.disks.map((d) => (
                <HealthBar key={d.mount} label={d.mount} pct={d.pct} detail={`${formatBytes(d.usedBytes)} / ${formatBytes(d.totalBytes)}`} warnAt={data?.thresholds.diskWarnPct} critAt={data?.thresholds.diskCriticalPct} />
              ))}
              <div className="mono text-[11px] text-fa">
                Xotira: {formatBytes(snapshot.memory.usedBytes)} / {formatBytes(snapshot.memory.totalBytes)} · swap {formatBytes(snapshot.memory.swapUsedBytes)} / {formatBytes(snapshot.memory.swapTotalBytes)}
                {snapshot.cpu.load1 != null ? ` · load ${snapshot.cpu.load1} ${snapshot.cpu.load5 ?? ""} ${snapshot.cpu.load15 ?? ""}` : ""}
              </div>
            </section>
            <section className="card flex flex-col gap-2 p-4" aria-label="Jarayonlar">
              <h3 className="text-sm font-semibold">Eng band jarayonlar</h3>
              <ProcTable title="CPU bo'yicha" rows={snapshot.topProcesses.byCpu} />
              <ProcTable title="RAM bo'yicha" rows={snapshot.topProcesses.byMem} />
              <div className="text-[11px] text-fa">Faqat jarayon nomi (argumentlar yig&apos;ilmaydi).</div>
            </section>
            <section className="card flex flex-col gap-2 p-4" aria-label="Konteynerlar">
              <h3 className="text-sm font-semibold">Konteynerlar</h3>
              {snapshot.docker ? <ContainerList containers={snapshot.docker.containers} available={snapshot.docker.available} reason={snapshot.docker.reason} /> : <div className="text-xs text-fa">Docker tekshirilmagan</div>}
              <FailedUnits units={snapshot.systemd?.failed ?? []} />
            </section>
          </div>
        ) : (
          <div className="card p-4 text-sm text-mu">agentd hali salomatlik ma&apos;lumotini yubormagan.</div>
        )}

        <section className="card flex flex-col gap-2 p-4" aria-label="Hodisalar" data-testid="incidents">
          <h3 className="text-sm font-semibold">Hodisalar</h3>
          {(data?.incidents ?? []).length === 0 ? <div className="text-xs text-fa">Tanlangan davrda hodisa yo&apos;q.</div> : null}
          <ul className="flex flex-col gap-1.5">
            {(data?.incidents ?? []).map((i) => (
              <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 text-xs" data-testid="incident" data-open={i.resolvedAt === null}>
                <span className="flex min-w-0 items-center gap-2">
                  <span className={`pill ${i.resolvedAt ? "bg-grn-bg text-grn" : i.severity === "critical" ? "bg-red-bg text-red" : "bg-org-bg text-org"}`} style={{ height: 18 }}>
                    {i.resolvedAt ? "yopilgan" : i.severity === "critical" ? "kritik" : "ogohlantirish"}
                  </span>
                  <span className="truncate">
                    <b>{incidentTitle(i)}</b> · {i.summary}
                  </span>
                </span>
                <span className="mono text-fa" suppressHydrationWarning>
                  {new Date(i.openedAt).toLocaleString("uz-UZ", { dateStyle: "short", timeStyle: "short" })}
                </span>
                <InvestigateControl kind="health" subjectId={i.id} items={investigations.items} eligible={canInvestigateIncident(i, to)} blocked={lockdown ? "Lockdown yoqiq" : !canControl ? "Boshqaruv token'i yo'q" : null} onChanged={investigations.reload} settingsHref={investigationSettingsHref(machineId)} />
              </li>
            ))}
          </ul>
        </section>

        <InvestigationSettingsForm machineId={machineId} canControl={canControl && !lockdown} />
        </div>
      </div>
    </>
  );
}

function ChartCard({ title, value, children }: { title: string; value: string; children: React.ReactNode }) {
  return (
    <section className="card flex flex-col gap-2 p-4">
      <div className="flex items-baseline justify-between">
        <h3 className="text-sm font-semibold">{title}</h3>
        <span className="mono text-sm">{value}</span>
      </div>
      {children}
    </section>
  );
}

function ProcTable({ title, rows }: { title: string; rows: Array<{ name: string; cpuPct: number; memPct: number }> }) {
  return (
    <div>
      <div className="mb-1 text-[11px] text-fa">{title}</div>
      {rows.length === 0 ? <div className="text-xs text-fa">—</div> : null}
      {rows.map((r) => (
        <div key={r.name} className="flex justify-between gap-2 text-xs">
          <span className="mono truncate">{r.name}</span>
          <span className="mono text-mu">
            {formatPct(r.cpuPct)} CPU · {formatPct(r.memPct)} RAM
          </span>
        </div>
      ))}
    </div>
  );
}
