"use client";

import type { HealthSnapshot, HealthStatus } from "@commander/contracts";
import Link from "next/link";
import { useMachineHealth } from "@/lib/use-health";
import { useNow } from "@/lib/use-now";
import { formatBytes, memPct } from "@/lib/health-view";
import { ContainerList, FailedUnits, HealthBar, HealthStatusPill, Sparkline } from "./HealthParts";

const DAY_MS = 24 * 3_600_000;

/** Mashinalar sahifasidagi har bir mashina kartasi ichidagi salomatlik bloki (CPU/RAM/disk, 24 soatlik sparkline, konteynerlar, failed unitlar). */
export function MachineHealthPanel({ machineId }: { machineId: string }) {
  const { data, live, error } = useMachineHealth(machineId, "24h");
  const now = useNow();
  const snapshot: HealthSnapshot | null = live?.snapshot ?? data?.latest ?? null;
  const status: HealthStatus = live?.status ?? data?.status ?? "unknown";

  if (error && !data) return <div className="border-t border-bd pt-2.5 text-xs text-fa">Salomatlik ma&apos;lumotini olib bo&apos;lmadi</div>;
  if (!data) return <div className="border-t border-bd pt-2.5 text-xs text-fa">Salomatlik yuklanmoqda…</div>;
  if (!snapshot) {
    return (
      <div className="flex flex-col gap-1.5 border-t border-bd pt-2.5" data-testid="health-panel">
        <div className="flex items-center justify-between text-xs">
          <span className="text-mu">Server holati</span>
          <HealthStatusPill status={status} />
        </div>
        <div className="text-xs text-fa">agentd hali salomatlik ma&apos;lumoti yubormagan (yangi versiya kerak).</div>
      </div>
    );
  }
  const maxDisk = [...snapshot.disks].sort((a, b) => b.pct - a.pct)[0];
  const to = (data.receivedAt ? Date.parse(data.receivedAt) : (now ?? 0));
  const t = data.thresholds;
  const failed = snapshot.systemd?.failed ?? [];
  return (
    <div className="flex flex-col gap-2.5 border-t border-bd pt-2.5" data-testid="health-panel">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-mu">Server holati</span>
        <div className="flex items-center gap-2">
          <HealthStatusPill status={status} />
          <Link href={`/machines/${machineId}`} className="text-[11px] text-blue hover:underline">
            Batafsil
          </Link>
        </div>
      </div>
      <HealthBar label="CPU" pct={snapshot.cpu.pct} detail={`${snapshot.cpu.cores} yadro`} warnAt={t.cpuPct - 10} critAt={t.cpuPct} />
      <HealthBar label="RAM" pct={memPct(snapshot)} detail={`${formatBytes(snapshot.memory.usedBytes)} / ${formatBytes(snapshot.memory.totalBytes)}`} warnAt={t.memPct - 10} critAt={t.memPct} />
      {maxDisk ? <HealthBar label={`Disk ${maxDisk.mount}`} pct={maxDisk.pct} detail={`${formatBytes(maxDisk.usedBytes)} / ${formatBytes(maxDisk.totalBytes)}`} warnAt={t.diskWarnPct} critAt={t.diskCriticalPct} /> : null}
      <div>
        <div className="mb-1 text-[11px] text-fa">CPU, so&apos;nggi 24 soat</div>
        <Sparkline series={data.series} pick={(p) => p.cpu} label="CPU, so'nggi 24 soat" fromTs={to - DAY_MS} toTs={to} />
      </div>
      {snapshot.docker ? <ContainerList containers={snapshot.docker.containers} available={snapshot.docker.available} reason={snapshot.docker.reason} limit={6} /> : null}
      <FailedUnits units={failed} />
    </div>
  );
}
