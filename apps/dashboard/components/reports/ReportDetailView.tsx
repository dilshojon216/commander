"use client";

import { ReportDtoSchema } from "@commander/contracts";
import type { ReportDto } from "@commander/contracts";
import Link from "next/link";
import { useEffect, useState } from "react";
import { ReportDataView } from "@/components/reports/ReportDataView";
import { PageHeader } from "@/components/ui/PageHeader";
import { ErrorState } from "@/components/ui/States";
import { IconBack } from "@/components/ui/icons";
import { getJson } from "@/lib/client-api";
import { formatDateTime } from "@/lib/format";
import { reportTitle, sentLabel } from "@/lib/reports-view";

/** Bitta hisobot sahifasi (`/reports/[id]`). */
export function ReportDetailView({ id }: { id: string }) {
  const [report, setReport] = useState<ReportDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const ctl = new AbortController();
    getJson(`/reports/${id}`, ReportDtoSchema, ctl.signal)
      .then(setReport)
      .catch((e: unknown) => {
        if (!ctl.signal.aborted) setError(e instanceof Error ? e.message : "Hisobotni olib bo'lmadi");
      });
    return () => ctl.abort();
  }, [id]);

  return (
    <>
      <PageHeader
        title={report ? reportTitle(report) : "Hisobot"}
        back={
          <Link href="/reports" className="btn" aria-label="Hisobotlarga qaytish">
            <IconBack size={14} />
          </Link>
        }
      >
        {report && (
          <>
            <span className="pill bg-s3 text-mu" suppressHydrationWarning>
              yaratilgan {formatDateTime(report.generatedAt)}
            </span>
            <span className={`pill ${report.sentAt ? "bg-grn-bg text-grn" : "bg-gray-bg text-mu"}`}>{sentLabel(report.sentAt)}</span>
          </>
        )}
      </PageHeader>
      <div className="flex w-full max-w-[1100px] flex-col gap-4 p-4 md:p-6">
        {error && <ErrorState title="Hisobotni olib bo'lmadi">{error}</ErrorState>}
        {!report && !error && <span className="text-mu">Yuklanmoqda...</span>}
        {report && <ReportDataView data={report.data} />}
      </div>
    </>
  );
}
