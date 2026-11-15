"use client";

import { ListReportsResponseSchema, ReportDtoSchema, ReportSettingsSchema } from "@commander/contracts";
import type { ReportKind, ReportSettings, ReportSummaryDto } from "@commander/contracts";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { useLiveData } from "@/components/LiveData";
import { ReportSettingsForm } from "@/components/reports/ReportSettingsForm";
import { PageHeader } from "@/components/ui/PageHeader";
import { ApiErrorBar, EmptyState } from "@/components/ui/States";
import { ApiCallError, getJson, postJson, requestJson } from "@/lib/client-api";
import { formatCost, formatDateTime, formatTokens } from "@/lib/format";
import { COST_LABEL, REPORT_KIND_LABEL, buildGenerateBody, filterReports, formatPeriod, sentLabel } from "@/lib/reports-view";

type KindFilter = ReportKind | "all";
const FILTERS: { id: KindFilter; label: string }[] = [
  { id: "all", label: "Hammasi" },
  { id: "daily", label: REPORT_KIND_LABEL.daily },
  { id: "weekly", label: REPORT_KIND_LABEL.weekly },
];

export interface ReportsListProps {
  items: ReportSummaryDto[];
}

/** Arxiv jadvali (faqat ko'rinish). */
export function ReportsList({ items }: ReportsListProps) {
  if (items.length === 0) return <EmptyState title="Hisobot yo'q">Hisobotlar jadval bo&apos;yicha yoki &quot;Hozir yaratish&quot; orqali paydo bo&apos;ladi.</EmptyState>;
  return (
    <div className="card overflow-hidden" data-testid="reports-list">
      {items.map((r) => (
        <Link key={r.id} href={`/reports/${r.id}`} className="row flex-wrap" style={{ padding: "12px 16px" }} data-testid="report-row">
          <span className="pill bg-s3">{REPORT_KIND_LABEL[r.kind]}</span>
          <span className="min-w-0 flex-1 basis-[160px] font-semibold">{formatPeriod(r.periodStart, r.periodEnd)}</span>
          <span className="text-xs text-mu">{r.tasksClosed} vazifa yopildi</span>
          <span className="mono text-xs text-mu">{formatTokens(r.totalTokens)}</span>
          <span className="mono text-xs text-mu" title={`${COST_LABEL}: obuna uchun haqiqiy to'lov emas`}>
            {r.costUsd === null ? "narx yo'q" : `≈ ${formatCost(r.costUsd)}`}
          </span>
          <span className={`pill ${r.sentAt ? "bg-grn-bg text-grn" : "bg-gray-bg text-mu"}`}>{sentLabel(r.sentAt)}</span>
          <span className="mono text-xs text-mu" suppressHydrationWarning>
            {formatDateTime(r.generatedAt)}
          </span>
        </Link>
      ))}
    </div>
  );
}

/** Hisobotlar sahifasi: arxiv, hozir yaratish, jadval sozlamalari. */
export function ReportsView() {
  const { canControl } = useLiveData();
  const router = useRouter();
  const [items, setItems] = useState<ReportSummaryDto[] | null>(null);
  const [filter, setFilter] = useState<KindFilter>("all");
  const [error, setError] = useState<string | null>(null);
  const [settings, setSettings] = useState<ReportSettings | null>(null);
  const [genKind, setGenKind] = useState<ReportKind>("daily");
  const [genSend, setGenSend] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);

  useEffect(() => {
    const ctl = new AbortController();
    getJson("/reports?limit=100", ListReportsResponseSchema, ctl.signal)
      .then((r) => {
        setItems(r.items);
        setError(null);
      })
      .catch((e: unknown) => {
        if (!ctl.signal.aborted) setError(e instanceof Error ? e.message : "Hisobotlarni olib bo'lmadi");
      });
    getJson("/reports/settings", ReportSettingsSchema, ctl.signal)
      .then(setSettings)
      .catch((e: unknown) => {
        if (!ctl.signal.aborted) setError(e instanceof Error ? e.message : "Sozlamalarni olib bo'lmadi");
      });
    return () => ctl.abort();
  }, []);

  const generate = () => {
    const body = buildGenerateBody(genKind, genSend);
    if (!body) return;
    setGenerating(true);
    setGenError(null);
    postJson("/reports/generate", body, ReportDtoSchema)
      .then((r) => router.push(`/reports/${r.id}`))
      .catch((e: unknown) => {
        setGenError(e instanceof ApiCallError && (e.status === 401 || e.status === 403) ? "Ruxsat yo'q: boshqaruv token'i yoki lockdown" : "Yaratib bo'lmadi, qayta urinib ko'ring");
        setGenerating(false);
      });
  };

  const save = useCallback(async (s: ReportSettings) => {
    try {
      await requestJson("PUT", "/reports/settings", s);
    } catch (e) {
      if (e instanceof ApiCallError && (e.status === 401 || e.status === 403)) throw new Error("Ruxsat yo'q: boshqaruv token'i yoki lockdown");
      throw new Error("Saqlab bo'lmadi, qayta urinib ko'ring");
    }
    setSettings(s);
  }, []);

  const shown = items ? filterReports(items, filter) : null;

  return (
    <>
      <PageHeader title="Hisobotlar" count={items ? items.length : undefined} />
      <div className="flex w-full max-w-[1100px] flex-col gap-5 p-4 md:p-6">
        <ApiErrorBar error={error} />

        <div className="flex flex-wrap items-center gap-3">
          <div className="flex gap-1.5" role="group" aria-label="Turi bo'yicha filtr">
            {FILTERS.map((f) => (
              <button key={f.id} type="button" className={`tchip ${filter === f.id ? "on" : ""}`} aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>
                {f.label}
              </button>
            ))}
          </div>
          {canControl && (
            <form
              className="ml-auto flex flex-wrap items-center gap-2"
              aria-label="Hozir yaratish"
              onSubmit={(e) => {
                e.preventDefault();
                generate();
              }}
            >
              <select className="field w-auto" value={genKind} onChange={(e) => setGenKind(e.target.value as ReportKind)} disabled={generating} aria-label="Hisobot turi" data-testid="gen-kind">
                <option value="daily">{REPORT_KIND_LABEL.daily}</option>
                <option value="weekly">{REPORT_KIND_LABEL.weekly}</option>
              </select>
              <label className="flex items-center gap-1.5 text-xs">
                <input type="checkbox" checked={genSend} onChange={(e) => setGenSend(e.target.checked)} disabled={generating} data-testid="gen-send" />
                Telegramga yuborish
              </label>
              <button type="submit" className="btn btn-ok" disabled={generating} data-testid="gen-submit">
                {generating ? "Yaratilmoqda..." : "Hozir yaratish"}
              </button>
            </form>
          )}
        </div>
        {genError && (
          <div role="alert" className="text-xs text-red">
            {genError}
          </div>
        )}

        {shown === null && !error && <span className="text-mu">Yuklanmoqda...</span>}
        {shown !== null && <ReportsList items={shown} />}

        <section className="flex flex-col gap-2.5" aria-label="Sozlamalar">
          <h2 className="m-0 text-sm font-semibold">Hisobot jadvali</h2>
          {settings ? <ReportSettingsForm initial={settings} canControl={canControl} onSave={save} /> : !error && <span className="text-mu">Yuklanmoqda...</span>}
        </section>
      </div>
    </>
  );
}
