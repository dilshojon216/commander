"use client";

import type { MachineDto } from "@commander/contracts";
import { useMemo } from "react";
import { useLiveData } from "@/components/LiveData";
import { RemoteControlHint } from "@/components/help/RemoteControlHint";
import { OsIcon } from "@/components/ui/icons";
import { MachineHealthPanel } from "@/components/machines/MachineHealthPanel";
import { LivePill, PageHeader } from "@/components/ui/PageHeader";
import { ApiErrorBar, EmptyState } from "@/components/ui/States";
import { formatDuration, formatTokens } from "@/lib/format";
import { machineLabel, osKind } from "@/lib/machines";
import { machineSessionParts } from "@/lib/machines-view";
import { needsRemoteEnable } from "@/lib/remote-control-hint";
import { todayTokensByMachine } from "@/lib/projects-view";
import { useNow } from "@/lib/use-now";

const PART_STYLE = {
  working: "text-blue bg-blue-bg",
  waiting: "text-yel bg-yel-bg",
  awaitingApproval: "text-org bg-org-bg",
  idle: "text-mu bg-gray-bg",
  done: "text-grn bg-grn-bg",
} as const;

export function MachinesView() {
  const { machines, projects, sessions, error } = useLiveData();
  const now = useNow();
  const online = machines.filter((m) => m.online).length;

  // Bugungi tokenlar: loyihalar bo'yicha mashinaga yig'ilgan (real)
  const todayByMachine = useMemo(() => todayTokensByMachine(projects?.items ?? [], projects?.archived), [projects]);
  const staleByMachine = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of sessions) if (s.staleSince !== null && s.endedAt === null) m.set(s.machineId, (m.get(s.machineId) ?? 0) + 1);
    return m;
  }, [sessions]);

  const sorted = useMemo(() => [...machines].sort((a, b) => Number(b.online) - Number(a.online) || machineLabel(a).localeCompare(machineLabel(b))), [machines]);

  return (
    <>
      <PageHeader title="Mashinalar" count={`${online} onlayn · ${machines.length - online} oflayn`}>
        <LivePill />
      </PageHeader>
      <div className="flex flex-col gap-3.5 px-4 py-5 md:px-6">
        <ApiErrorBar error={error} />
        {sorted.length === 0 ? (
          <EmptyState title="Mashina yo'q">agentd o&apos;rnatilgan mashinalar shu yerda ko&apos;rinadi.</EmptyState>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,300px),1fr))] content-start gap-3.5">
            {sorted.map((m) => (
              <MachineDetailCard key={m.id} m={m} now={now} todayTokens={todayByMachine.get(m.id) ?? 0} stale={staleByMachine.get(m.id) ?? 0} />
            ))}
          </div>
        )}
      </div>
    </>
  );
}

function MachineDetailCard({ m, now, todayTokens, stale }: { m: MachineDto; now: number; todayTokens: number; stale: number }) {
  const parts = machineSessionParts(m.sessions);
  const seen = m.lastSeenAt ? Date.parse(m.lastSeenAt) : NaN;
  const since = m.connectedAt ? Date.parse(m.connectedAt) : NaN;
  const kv = (k: string, v: string) => (
    <div className="flex justify-between gap-2 text-xs">
      <span className="text-mu">{k}</span>
      <span className="mono">{v}</span>
    </div>
  );
  return (
    <article className={`card flex flex-col gap-3 p-4 ${m.online ? "" : "border-dashed border-fa bg-transparent"}`} data-testid="machine-detail" data-online={m.online}>
      <div className="flex items-center gap-2.5">
        <div className="flex size-9 items-center justify-center rounded-lg bg-s3 text-mu">
          <OsIcon os={osKind(m.os)} />
        </div>
        <div className="min-w-0 flex-1">
          <div className={`mono truncate text-sm font-semibold ${m.online ? "" : "opacity-60"}`}>{machineLabel(m)}</div>
          <div className="mono truncate text-[11px] text-mu">
            {osKind(m.os)} · {m.hostname ?? "—"}
          </div>
        </div>
        <span className={`pill ${m.online ? "bg-grn-bg text-grn" : "bg-gray-bg text-mu"}`}>
          <span className={`dot ${m.online ? "live" : ""}`} />
          {m.online ? "Onlayn" : "Oflayn"}
        </span>
      </div>

      {!m.online && (
        <div className="flex items-center gap-2 rounded-[7px] bg-org-bg px-2.5 py-2 text-xs text-org">
          <span aria-hidden="true">⚠</span>
          <span suppressHydrationWarning>
            {now && !Number.isNaN(seen) ? `${formatDuration(Math.max(0, now - seen))} oldin oxirgi marta ko'rilgan.` : "Oxirgi ko'rilgan vaqt noma'lum."}
            {stale > 0 ? ` ${stale} sessiya "Aloqa yo'q" holatida.` : ""}
          </span>
        </div>
      )}

      <div className={`flex flex-col gap-1.5 ${m.online ? "" : "opacity-60"}`}>
        {kv(m.online ? "Onlayn" : "Oxirgi ko'rilgan", m.online ? (now && !Number.isNaN(since) ? formatDuration(Math.max(0, now - since)) : "—") : now && !Number.isNaN(seen) ? `${formatDuration(Math.max(0, now - seen))} oldin` : "—")}
        {kv("agentd", m.agentdVersion ?? "—")}
        {kv("Claude Code", m.claudeVersion ?? "—")}
        {kv("Bugungi tokenlar", todayTokens > 0 ? formatTokens(todayTokens) : "—")}
      </div>

      <div className={`flex flex-wrap gap-1.5 border-t border-bd pt-2.5 ${m.online ? "" : "opacity-60"}`}>
        {parts.map((p) => (
          <span key={p.key} className={`pill ${PART_STYLE[p.key]}`} style={{ height: 20 }}>
            {p.n} {p.label}
          </span>
        ))}
        {parts.length === 0 && <span className="text-xs text-fa">Ochiq sessiya yo&apos;q</span>}
      </div>

      {needsRemoteEnable(m) && <RemoteControlHint machineName={machineLabel(m)} />}

      {m.online && <MachineHealthPanel machineId={m.id} />}
    </article>
  );
}
