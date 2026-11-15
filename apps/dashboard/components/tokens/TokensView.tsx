"use client";

import { UsageResponseSchema } from "@commander/contracts";
import type { UsageBucket, UsageGroupBy, UsageResponse } from "@commander/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BarChart } from "@/components/charts/BarChart";
import { useLiveData } from "@/components/LiveData";
import { LivePill, PageHeader } from "@/components/ui/PageHeader";
import { ApiErrorBar, SkeletonCard } from "@/components/ui/States";
import { ALL_TOKEN_TYPES, DESIGN_MAX_SERIES, buildChartData, selectedTotal } from "@/lib/chart-data";
import type { TokenType, TokenTypes } from "@/lib/chart-data";
import { getJson } from "@/lib/client-api";
import { formatClock, formatCost, formatCount, formatDayLabel, formatTokens } from "@/lib/format";
import { shortMachineName } from "@/lib/machines";
import { RANGE_PRESETS, buildUsageQuery, clampRange } from "@/lib/usage-query";
import { useLiveSync } from "@/lib/use-live-sync";

interface Query {
  bucket: UsageBucket;
  groupBy: UsageGroupBy;
  rangeMs: number;
}

const BUCKETS: { id: UsageBucket; label: string }[] = [
  { id: "5m", label: "5 daq" },
  { id: "1h", label: "1 soat" },
  { id: "1d", label: "1 kun" },
];
const GROUPS: { id: UsageGroupBy; label: string }[] = [
  { id: "project", label: "Loyiha" },
  { id: "machine", label: "Mashina" },
  { id: "model", label: "Model" },
  { id: "none", label: "Jami" },
];
const TYPES: { id: TokenType; label: string }[] = [
  { id: "input", label: "input" },
  { id: "output", label: "output" },
  { id: "cacheRead", label: "cache read" },
  { id: "cacheWrite", label: "cache write" },
];

function fetchUsage(q: Query, signal?: AbortSignal): Promise<UsageResponse> {
  return getJson(`/usage?${buildUsageQuery(q.bucket, q.groupBy, q.rangeMs, Date.now())}`, UsageResponseSchema, signal);
}

export function TokensView() {
  const { error: apiError } = useLiveData();
  const [query, setQuery] = useState<Query>({ bucket: "1d", groupBy: "project", rangeMs: 30 * 86_400_000 });
  const [types, setTypes] = useState<TokenTypes>(ALL_TOKEN_TYPES);
  const [resp, setResp] = useState<UsageResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const queryRef = useRef(query);
  const tickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    queryRef.current = query;
    const ctl = new AbortController();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- so'rov boshlanganda yuklanish belgisi
    setLoading(true);
    fetchUsage(query, ctl.signal)
      .then((r) => {
        setResp(r);
        setError(null);
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (ctl.signal.aborted) return;
        setError(e instanceof Error ? e.message : "Xatolik");
        setLoading(false);
      });
    return () => ctl.abort();
  }, [query]);

  const fetchSnapshot = useCallback((signal: AbortSignal) => fetchUsage(queryRef.current, signal), []);
  useLiveSync<UsageResponse>({
    fetchSnapshot,
    onSnapshot: setResp,
    onError: setError,
    onPush: (e) => {
      if (e.type !== "usage.tick" || tickTimer.current) return;
      // Delta'lar jamlanmaydi: 4 s ichida bitta qayta so'rov (aniq qiymat REST'dan)
      tickTimer.current = setTimeout(() => {
        tickTimer.current = null;
        fetchUsage(queryRef.current)
          .then(setResp)
          .catch(() => undefined);
      }, 4000);
    },
  });
  useEffect(
    () => () => {
      if (tickTimer.current) clearTimeout(tickTimer.current);
    },
    [],
  );

  const chart = useMemo(() => (resp ? buildChartData(resp, types, DESIGN_MAX_SERIES) : null), [resp, types]);
  const labelOf = (label: string) => (query.groupBy === "machine" ? shortMachineName(label) : label);

  const grand = useMemo(() => {
    if (!chart) return null;
    return chart.series.reduce((a, s) => ({ tokens: a.tokens + selectedTotal(s.totals, types), requests: a.requests + s.totals.requests, cost: s.totals.costUsd === null ? a.cost : (a.cost ?? 0) + s.totals.costUsd }), { tokens: 0, requests: 0, cost: null as number | null });
  }, [chart, types]);

  const rangeLabel = RANGE_PRESETS[query.bucket].find((p) => p.ms === query.rangeMs)?.label ?? "";
  const bucketLabel = BUCKETS.find((b) => b.id === query.bucket)?.label ?? "";
  const groupLabel = GROUPS.find((g) => g.id === query.groupBy)?.label ?? "";

  const fmtTime = (t: number) => (query.bucket === "1d" ? formatDayLabel(t) : `${formatDayLabel(t)} ${formatClock(t)}`);
  const columns = chart
    ? chart.times.map((t, i) => {
        const parts = chart.series.map((s) => ({ value: s.values[i] ?? 0, color: s.color, label: labelOf(s.label) }));
        const sum = parts.reduce((a, p) => a + p.value, 0);
        return {
          title: `${fmtTime(t)} · ${formatTokens(sum)} token${parts.length > 1 ? "\n" + parts.filter((p) => p.value > 0).map((p) => `${p.label}: ${formatTokens(p.value)}`).join("\n") : ""}`,
          parts: parts.map((p) => ({ value: p.value, color: p.color })),
        };
      })
    : [];
  const xLabels = chart && chart.times.length > 0 ? [0, 0.25, 0.5, 0.75, 1].map((f) => (query.bucket === "1d" ? formatDayLabel(chart.times[Math.round(f * (chart.times.length - 1))]) : formatClock(chart.times[Math.round(f * (chart.times.length - 1))]))) : [];

  const toggle = (id: TokenType) => setTypes((t) => ({ ...t, [id]: !t[id] }));

  return (
    <>
      <PageHeader title="Tokenlar">
        <LivePill />
      </PageHeader>
      <div className="flex flex-col gap-4 px-4 py-5 md:px-6">
        <ApiErrorBar error={error ?? apiError} />

        <div className="flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-2" role="group" aria-label="Davr">
            <span className="lbl">Davr</span>
            <div className="segs">
              {BUCKETS.map((b) => (
                <button key={b.id} type="button" className={`seg ${query.bucket === b.id ? "on" : ""}`} aria-pressed={query.bucket === b.id} onClick={() => setQuery((q) => ({ ...q, bucket: b.id, rangeMs: clampRange(b.id, q.rangeMs) }))}>
                  {b.label}
                </button>
              ))}
            </div>
          </div>
          <div className="flex items-center gap-2" role="group" aria-label="Guruh">
            <span className="lbl">Guruh</span>
            <div className="segs">
              {GROUPS.map((g) => (
                <button key={g.id} type="button" className={`seg ${query.groupBy === g.id ? "on" : ""}`} aria-pressed={query.groupBy === g.id} onClick={() => setQuery((q) => ({ ...q, groupBy: g.id }))}>
                  {g.label}
                </button>
              ))}
            </div>
          </div>
          <div className="flex items-center gap-2" role="group" aria-label="Oraliq">
            <span className="lbl">Oraliq</span>
            <div className="segs">
              {RANGE_PRESETS[query.bucket].map((p) => (
                <button key={p.ms} type="button" className={`seg ${query.rangeMs === p.ms ? "on" : ""}`} aria-pressed={query.rangeMs === p.ms} onClick={() => setQuery((q) => ({ ...q, rangeMs: p.ms }))}>
                  {p.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Token turi">
          <span className="lbl mr-1">Token turi</span>
          {TYPES.map((t) => (
            <button key={t.id} type="button" className={`tchip ${types[t.id] ? "on" : ""}`} aria-pressed={types[t.id]} onClick={() => toggle(t.id)}>
              <span aria-hidden="true">{types[t.id] ? "✓" : "○"}</span>
              {t.label}
            </button>
          ))}
          <span className="ml-2 text-xs text-mu">cache read jami tokenning ≈99% ini tashkil qiladi. Boshqa turlarni ko&apos;rish uchun uni o&apos;chiring.</span>
        </div>

        {loading && !chart ? (
          <SkeletonCard lines={5} />
        ) : chart ? (
          <>
            <section className="card flex flex-col gap-3 px-4 pb-3 pt-4" aria-label="Token grafigi">
              <div className="flex flex-wrap items-baseline gap-4">
                <span className="mono text-2xl font-semibold">{formatTokens(grand?.tokens ?? 0)}</span>
                <span className="text-mu">
                  jami · {rangeLabel} · {bucketLabel} oraliq bilan
                </span>
                <span className="flex-1" />
                {chart.series.map((s) => (
                  <span key={s.key} className="inline-flex items-center gap-1.5 text-xs">
                    <span className="size-2.5 rounded-sm" style={{ background: s.color }} aria-hidden="true" />
                    {labelOf(s.label)}
                  </span>
                ))}
              </div>
              <BarChart height={280} yWidth={40} xLabels={xLabels} columns={columns} label={`Token grafigi: ${groupLabel} bo'yicha, jami ${formatTokens(grand?.tokens ?? 0)}`} />
            </section>

            <section className="card overflow-x-auto" aria-label="Jadval">
              <table className="dtable" style={{ fontFamily: "var(--font-mono)" }}>
                <thead>
                  <tr>
                    <th scope="col">{groupLabel}</th>
                    {["input", "output", "cache read", "cache write", "jami", "so'rov", "≈ API ekv."].map((h) => (
                      <th key={h} scope="col" className="r">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {chart.series.map((s) => (
                    <tr key={s.key}>
                      <td style={{ padding: "10px 14px" }}>
                        <span className="inline-flex items-center gap-2 font-semibold" style={{ fontFamily: "var(--font-sans)" }}>
                          <span className="size-2.5 rounded-sm" style={{ background: s.color }} aria-hidden="true" />
                          {labelOf(s.label)}
                        </span>
                      </td>
                      <Num v={s.totals.inputTokens} muted dim={!types.input} />
                      <Num v={s.totals.outputTokens} dim={!types.output} />
                      <Num v={s.totals.cacheReadTokens} muted dim={!types.cacheRead} />
                      <Num v={s.totals.cacheCreationTokens} muted dim={!types.cacheWrite} />
                      <td className="r font-semibold" style={{ padding: "10px 14px" }}>
                        {formatTokens(selectedTotal(s.totals, types))}
                      </td>
                      <td className="r text-mu" style={{ padding: "10px 14px" }}>
                        {formatCount(s.totals.requests)}
                      </td>
                      <td className="r text-mu" style={{ padding: "10px 14px" }}>
                        {formatCost(s.totals.costUsd)}
                      </td>
                    </tr>
                  ))}
                  {chart.series.length === 0 && (
                    <tr>
                      <td colSpan={8} className="text-mu" style={{ padding: "14px" }}>
                        Bu oraliqda ma&apos;lumot yo&apos;q.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </section>
            <span className="text-xs text-fa">Obunada bu haqiqiy to&apos;lov emas: &quot;API ekvivalenti&quot; bir xil tokenlar API orqali qancha turishini ko&apos;rsatadi.</span>
          </>
        ) : null}
      </div>
    </>
  );
}

function Num({ v, muted, dim }: { v: number; muted?: boolean; dim?: boolean }) {
  return (
    <td className={`r ${muted ? "text-mu" : ""}`} style={{ padding: "10px 14px", opacity: dim ? 0.4 : 1 }} title={`${formatCount(v)} token`}>
      {formatTokens(v)}
    </td>
  );
}
