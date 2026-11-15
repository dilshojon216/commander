"use client";

import { SessionSummaryResponseSchema } from "@commander/contracts";
import type { SessionSummaryDto } from "@commander/contracts";
import { useEffect, useMemo, useState } from "react";
import { getJson } from "@/lib/client-api";
import { formatDateTime } from "@/lib/format";
import { SUMMARY_EMPTY_HINT, SUMMARY_EMPTY_TITLE, buildSummaryCard } from "@/lib/summary-view";

function List({ title, items, mono }: { title: string; items: string[]; mono?: boolean }) {
  if (items.length === 0) return null;
  return (
    <div className="flex flex-col gap-1">
      <span className="lbl">{title}</span>
      <ul className="m-0 flex list-none flex-col gap-1 p-0">
        {items.map((t, i) => (
          <li key={`${i}:${t}`} className={`text-xs ${mono ? "mono break-all text-mu" : ""}`}>
            {mono ? t : `• ${t}`}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Sessiya xulosasi kartasi (Server emas: client). `refreshKey` o'zgarganda (sessiya tugadi) qayta o'qiladi. */
export function SummaryCard({ sessionId, refreshKey }: { sessionId: string; refreshKey: string }) {
  const [dto, setDto] = useState<SessionSummaryDto | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const ctl = new AbortController();
    getJson(`/sessions/${sessionId}/summary`, SessionSummaryResponseSchema, ctl.signal)
      .then((r) => {
        setDto(r.summary);
        setError(null);
        setLoaded(true);
      })
      .catch((e: unknown) => {
        if (ctl.signal.aborted) return;
        setError(e instanceof Error ? e.message : "Xulosani olib bo'lmadi");
        setLoaded(true);
      });
    return () => ctl.abort();
  }, [sessionId, refreshKey]);

  const view = useMemo(() => buildSummaryCard(dto), [dto]);

  return (
    <section className="flex flex-col gap-2.5" aria-label="Xulosa" data-testid="summary-card">
      <span className="lbl">Xulosa</span>
      {!loaded && <div className="sk h-16" aria-busy="true" />}
      {loaded && error && (
        <span role="alert" className="text-xs text-red">
          {error}
        </span>
      )}
      {loaded && !error && view.empty && (
        <div className="flex flex-col gap-1" data-testid="summary-empty">
          <b className="text-xs">{SUMMARY_EMPTY_TITLE}</b>
          <span className="text-xs text-mu">{SUMMARY_EMPTY_HINT}</span>
        </div>
      )}
      {loaded && !error && !view.empty && (
        <>
          <p className="m-0 whitespace-pre-wrap text-xs" data-testid="summary-text">
            {view.summary}
          </p>
          <List title="Bajarilgan" items={view.done} />
          <List title="Fayllar" items={view.files} mono />
          {view.hiddenFiles > 0 && <span className="text-[11px] text-mu">… yana {view.hiddenFiles} ta fayl</span>}
          <List title="Ochiq qolgan" items={view.openItems} />
          <span className="mono text-[11px] text-fa" suppressHydrationWarning>
            {view.model} · {view.triggerLabel}
            {view.createdAt ? ` · ${formatDateTime(view.createdAt)}` : ""}
          </span>
        </>
      )}
    </section>
  );
}
