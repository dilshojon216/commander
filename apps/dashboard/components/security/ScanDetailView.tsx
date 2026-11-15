"use client";

import type { ScanDetail, ScanFinding, ScanFindingKind, ScanSeverity } from "@commander/contracts";
import { SCAN_FIX_PERMISSION_MODE } from "@commander/contracts";
import Link from "next/link";
import { useMemo, useState } from "react";
import { useLiveData } from "@/components/LiveData";
import { useShellUi } from "@/components/shell/ShellUi";
import { LivePill, PageHeader } from "@/components/ui/PageHeader";
import { ApiErrorBar } from "@/components/ui/States";
import { SCAN_KIND_LABEL, SCAN_SEVERITY_LABEL, SCAN_SEVERITY_ORDER, SCAN_SEVERITY_TONE, SCAN_TOOL_STATUS_LABEL, SCAN_TOOL_STATUS_TONE, filterFindings, findingSubject, fixPromptFor, scanAge, sortBySeverity } from "@/lib/scan-view";
import { useScanDetail } from "@/lib/use-scans";
import { useNow } from "@/lib/use-now";

export function FindingsTable({ findings, onFix }: { findings: ScanFinding[]; onFix?: (f: ScanFinding) => void }) {
  if (findings.length === 0) return <span className="text-xs text-mu">Mos topilma yo&apos;q.</span>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs" data-testid="findings-table">
        <thead>
          <tr className="text-left text-mu">
            <th className="py-1.5 pr-3">Jiddiylik</th>
            <th className="pr-3">Tur</th>
            <th className="pr-3">Joyi / paket</th>
            <th className="pr-3">Advisory</th>
            <th>Tavsif</th>
            {onFix ? <th /> : null}
          </tr>
        </thead>
        <tbody>
          {findings.map((f, i) => (
            <tr key={i} className="border-t border-bd align-top" data-testid="finding-row">
              <td className="py-1.5 pr-3">
                <span className={`pill ${SCAN_SEVERITY_TONE[f.severity]}`}>{SCAN_SEVERITY_LABEL[f.severity]}</span>
              </td>
              <td className="pr-3">{SCAN_KIND_LABEL[f.kind]}</td>
              <td className="mono pr-3">{findingSubject(f)}</td>
              <td className="mono pr-3">{f.advisoryIds.join(", ") || "—"}</td>
              <td>{f.title}</td>
              {onFix ? (
                <td className="pl-3">
                  <button type="button" className="btn" onClick={() => onFix(f)}>
                    Claude tuzatsin
                  </button>
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ScanDetailBody({ scan, canFix, onFix }: { scan: ScanDetail; canFix: boolean; onFix: (findings: ScanFinding[]) => void }) {
  const now = useNow();
  const [kind, setKind] = useState<ScanFindingKind | "all">("all");
  const [severity, setSeverity] = useState<ScanSeverity | "all">("all");
  const rows = useMemo(() => filterFindings(sortBySeverity(scan.findings), { kind, severity }), [scan.findings, kind, severity]);
  return (
    <div className="flex flex-col gap-4">
      <div className="card flex flex-wrap items-center gap-3 p-4">
        <b>{scan.projectName}</b>
        <span className="mono text-xs text-mu">{scan.machineName}</span>
        <span className="text-xs text-mu" suppressHydrationWarning>
          {scanAge(scan.scannedAt, now)} · {Math.round(scan.durationMs / 1000)} s · {scan.filesScanned} fayl
        </span>
        <span className="flex-1" />
        <button type="button" className="btn btn-pri" disabled={!canFix || scan.findings.length === 0} onClick={() => onFix(rows.length > 0 ? rows : scan.findings)} data-testid="fix-all">
          Claude tuzatsin
        </button>
      </div>
      <section className="card flex flex-col gap-2 p-4" aria-label="Asboblar">
        <h2 className="m-0 text-sm font-semibold">Asboblar</h2>
        <div className="flex flex-wrap gap-2" data-testid="scan-tools">
          {scan.tools.map((t) => (
            <span key={t.tool} className={`pill ${SCAN_TOOL_STATUS_TONE[t.status]}`} title={t.detail}>
              {t.tool}: {SCAN_TOOL_STATUS_LABEL[t.status]}
              {t.status === "ok" ? ` (${t.findings})` : ""}
            </span>
          ))}
        </div>
      </section>
      <section className="card flex flex-col gap-3 p-4" aria-label="Topilmalar">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="m-0 flex-1 text-sm font-semibold">
            Topilmalar <span className="font-normal text-mu">{scan.truncated ? `(eng muhim ${scan.findings.length} / ${scan.findingsTotal})` : `(${scan.findingsTotal})`}</span>
          </h2>
          <select className="field" value={kind} onChange={(e) => setKind(e.target.value as ScanFindingKind | "all")} aria-label="Tur" data-testid="filter-kind">
            <option value="all">Hamma tur</option>
            {(Object.keys(SCAN_KIND_LABEL) as ScanFindingKind[]).map((k) => (
              <option key={k} value={k}>
                {SCAN_KIND_LABEL[k]}
              </option>
            ))}
          </select>
          <select className="field" value={severity} onChange={(e) => setSeverity(e.target.value as ScanSeverity | "all")} aria-label="Jiddiylik" data-testid="filter-severity">
            <option value="all">Hamma jiddiylik</option>
            {SCAN_SEVERITY_ORDER.map((s) => (
              <option key={s} value={s}>
                {SCAN_SEVERITY_LABEL[s]}
              </option>
            ))}
          </select>
        </div>
        <FindingsTable findings={rows} onFix={canFix ? (f) => onFix([f]) : undefined} />
      </section>
    </div>
  );
}

export function ScanDetailView({ scanId }: { scanId: string }) {
  const { data, error } = useScanDetail(scanId);
  const { projects, canControl, lockdown } = useLiveData();
  const { openNewSession } = useShellUi();
  const project = data ? projects?.items.find((p) => p.id === data.projectId) : undefined;
  const canFix = canControl && !lockdown && !!data && !!project;

  function fix(findings: ScanFinding[]) {
    if (!data || !project) return;
    // Mavjud "Yangi sessiya" oynasi oldindan to'ldirilgan: plan rejimi, loyiha mashinasi va papkasi
    openNewSession({ machineId: data.machineId, cwd: project.path, prompt: fixPromptFor(data.projectName, data.scannedAt, findings), permissionMode: SCAN_FIX_PERMISSION_MODE });
  }

  return (
    <>
      <PageHeader title="Tekshiruv natijasi" count={data?.projectName}>
        <LivePill />
      </PageHeader>
      <div className="flex w-full max-w-[1100px] flex-col gap-4 p-4 md:p-6">
        <Link href="/security" className="text-xs text-blue hover:underline">
          ← Xavfsizlik
        </Link>
        <ApiErrorBar error={error} />
        {data ? <ScanDetailBody scan={data} canFix={canFix} onFix={fix} /> : error ? null : <span className="text-mu">Yuklanmoqda…</span>}
      </div>
    </>
  );
}
