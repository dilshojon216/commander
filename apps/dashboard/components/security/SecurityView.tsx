"use client";

import type { ProjectScanSummary, ScanSettings } from "@commander/contracts";
import Link from "next/link";
import { useMemo, useState } from "react";
import { useLiveData } from "@/components/LiveData";
import { LivePill, PageHeader } from "@/components/ui/PageHeader";
import { ApiErrorBar, EmptyState } from "@/components/ui/States";
import { ApiCallError } from "@/lib/client-api";
import { SCAN_SEVERITY_LABEL, SCAN_SEVERITY_ORDER, SCAN_SEVERITY_TONE, projectNeedsAttention, scanAge, scheduleLabel, sortScanProjects, trendBars, normalizeTrend } from "@/lib/scan-view";
import { runScan, saveScanSettings, useScans } from "@/lib/use-scans";
import { useNow } from "@/lib/use-now";

/** Haftalik trend: mini-ustunlar (kritik + yuqori + sirlar). */
export function TrendBars({ trend }: { trend: ProjectScanSummary["trend"] }) {
  const bars = trendBars(normalizeTrend(trend));
  if (bars.length < 2) return <span className="text-[11px] text-fa">trend: ma&apos;lumot kam</span>;
  return (
    <div className="flex h-6 items-end gap-0.5" role="img" aria-label="Kritik, yuqori va sirlar trendi" data-testid="scan-trend">
      {bars.map((b) => (
        <div key={b.at} title={`${b.at.slice(0, 10)}: ${b.value}`} className={`w-1.5 rounded-sm ${b.value > 0 ? "bg-red" : "bg-s3"}`} style={{ height: `${Math.max(8, b.pct)}%` }} />
      ))}
    </div>
  );
}

/** Loyiha kartochkasi (props orqali; testlanadi). */
export function ScanProjectCard({ p, now, scanning, canControl, onRun }: { p: ProjectScanSummary; now: number; scanning: boolean; canControl: boolean; onRun: () => void }) {
  const attention = projectNeedsAttention(p);
  return (
    <section className={`card flex flex-col gap-2.5 p-4 ${attention ? "border-org" : ""}`} aria-label={p.projectName} data-testid="scan-card">
      <div className="flex flex-wrap items-center gap-2">
        <Link href={`/security/${p.scanId}`} className="text-sm font-semibold">
          {p.projectName}
        </Link>
        <span className="mono text-xs text-mu">{p.machineName}</span>
        <span className="flex-1" />
        <span className="text-xs text-mu" suppressHydrationWarning>
          {scanAge(p.scannedAt, now)}
        </span>
        <button type="button" className="btn" disabled={!canControl || scanning} onClick={onRun} data-testid="scan-run">
          {scanning ? "Tekshirilmoqda…" : "Hozir tekshirish"}
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {SCAN_SEVERITY_ORDER.filter((s) => s !== "info").map((s) => (
          <span key={s} className={`pill ${p.counts[s] > 0 ? SCAN_SEVERITY_TONE[s] : "bg-gray-bg text-mu"}`} data-testid={`count-${s}`}>
            {SCAN_SEVERITY_LABEL[s]} {p.counts[s]}
          </span>
        ))}
        <span className={`pill ${p.secretCount > 0 ? "bg-red-bg text-red" : "bg-gray-bg text-mu"}`} data-testid="count-secrets">
          Sirlar {p.secretCount}
        </span>
        <span className={`pill ${p.envFileCount > 0 ? "bg-yel-bg text-yel" : "bg-gray-bg text-mu"}`}>.env {p.envFileCount}</span>
        <span className="pill bg-gray-bg text-mu">Eskirgan {p.outdatedCount}</span>
        {p.partial ? (
          <span className="pill bg-yel-bg text-yel" title="Ba'zi asboblar ishlamadi yoki o'rnatilmagan: natija to'liq emas" data-testid="scan-partial">
            Qisman
          </span>
        ) : null}
        <span className="flex-1" />
        <TrendBars trend={p.trend} />
      </div>
    </section>
  );
}

export function SecurityView() {
  const { canControl, lockdown } = useLiveData();
  const now = useNow();
  const [scanning, setScanning] = useState<Record<string, string>>({});
  const watch = Object.keys(scanning).length > 0;
  const { data, error, reload } = useScans(watch);
  const [msg, setMsg] = useState<string | null>(null);
  const [settingsErr, setSettingsErr] = useState<string | null>(null);
  const can = canControl && !lockdown;

  // "Tekshirilmoqda": natija (scannedAt) o'zgarguncha yoki 3 daqiqagacha (effektsiz: har renderda hisoblanadi)
  const isScanning = (p: ProjectScanSummary): boolean => {
    const b = scanning[p.projectId];
    if (!b) return false;
    const [at, since] = b.split("|");
    return p.scannedAt === at && now - Number(since) <= 180_000;
  };

  const projects = useMemo(() => sortScanProjects(data?.projects ?? []), [data]);

  async function run(p: ProjectScanSummary) {
    setMsg(null);
    try {
      await runScan(p.projectId);
      setScanning((c) => ({ ...c, [p.projectId]: `${p.scannedAt}|${Date.now()}` }));
      reload();
    } catch (e) {
      setMsg(e instanceof ApiCallError && e.body && typeof e.body === "object" && "message" in e.body ? String((e.body as { message: unknown }).message) : "Tekshiruvni boshlab bo'lmadi");
    }
  }

  async function toggle(patch: Partial<ScanSettings>) {
    if (!data) return;
    setSettingsErr(null);
    try {
      await saveScanSettings({ ...data.settings, ...patch });
      reload();
    } catch (e) {
      setSettingsErr(e instanceof ApiCallError && (e.status === 401 || e.status === 403) ? "Ruxsat yo'q: qayta tasdiqlash yoki token kerak." : "Saqlab bo'lmadi.");
    }
  }

  return (
    <>
      <PageHeader title="Xavfsizlik" count="Haftalik dependency va sir tekshiruvi">
        <LivePill />
      </PageHeader>
      <div className="flex w-full max-w-[1100px] flex-col gap-4 p-4 md:p-6">
        <ApiErrorBar error={error} />
        {data ? (
          <section className="card flex flex-wrap items-center gap-4 p-4" aria-label="Sozlamalar" data-testid="scan-settings">
            <span className="text-xs text-mu">{scheduleLabel(data.nextRunAt, data.lastRunAt, data.settings.enabled)}</span>
            <span className="flex-1" />
            <label className="flex items-center gap-2 text-xs">
              <input type="checkbox" checked={data.settings.enabled} disabled={!can} onChange={(e) => void toggle({ enabled: e.target.checked })} data-testid="scan-enabled" />
              Haftalik tekshiruv (yakshanba 06:00)
            </label>
            <label className="flex items-center gap-2 text-xs">
              <input type="checkbox" checked={data.settings.digest} disabled={!can} onChange={(e) => void toggle({ digest: e.target.checked })} data-testid="scan-digest" />
              Telegram dayjest
            </label>
            {settingsErr ? (
              <span role="alert" className="text-xs text-red">
                {settingsErr}
              </span>
            ) : null}
            <span className="w-full text-[11px] text-fa">Sozlamani o&apos;zgartirish yangi tasdiq (Touch ID/parol) talab qiladi. Tekshiruv faqat o&apos;qiydi: hech narsa o&apos;rnatilmaydi yoki o&apos;zgartirilmaydi.</span>
          </section>
        ) : null}
        {msg ? (
          <div role="alert" className="rounded-md bg-red-bg px-3 py-2 text-xs text-red">
            {msg}
          </div>
        ) : null}
        {data && projects.length === 0 ? (
          <EmptyState title="Hali tekshiruv yo'q">Birinchi tekshiruv yakshanba kuni bajariladi yoki loyiha sahifasidan qo&apos;lda ishga tushiring.</EmptyState>
        ) : (
          projects.map((p) => <ScanProjectCard key={p.projectId} p={p} now={now} scanning={isScanning(p)} canControl={can} onRun={() => void run(p)} />)
        )}
      </div>
    </>
  );
}
