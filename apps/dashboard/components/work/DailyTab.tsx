"use client";

import { DailyResponseSchema } from "@commander/contracts";
import type { DailyDay } from "@commander/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CommandProgress } from "@/components/control/CommandProgress";
import { useTrackedCommand } from "@/components/control/useControl";
import { getJson } from "@/lib/client-api";
import { isInFlight } from "@/lib/control-ui";
import { useLive } from "@/lib/live-client";
import { displayKey, summaryHeading } from "@/lib/parts-view";
import { buildDailyView, dayChoices, dayLabel, tashkentDate } from "@/lib/work-view";
import { useNow } from "@/lib/use-now";
import { useWorkApi } from "./useWorkApi";

const RATIO_FG = { mu: "text-mu", grn: "text-grn", yel: "text-yel", red: "text-red" } as const;

export function DailyTab({ projectId, writeReason, refreshKey, part }: { projectId: string; writeReason: string | null; refreshKey: number; /** 6.15: qism filtri ('' = asosiy, undefined = hammasi). */ part?: string }) {
  const now = useNow();
  const [mountNow] = useState(() => Date.now());
  const today = tashkentDate(now || mountNow);
  const [date, setDate] = useState<string | null>(null);
  const sel = date ?? today;
  const [day, setDay] = useState<DailyDay | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const api = useWorkApi(projectId);
  const [cmdId, setCmdId] = useState<string | null>(null);
  const [sumError, setSumError] = useState<string | null>(null);
  const cmd = useTrackedCommand(cmdId);
  const lastStatus = useRef<string | null>(null);

  const load = useCallback(
    (signal?: AbortSignal) =>
      getJson(`/projects/${projectId}/daily?from=${sel}&to=${sel}${part === undefined ? "" : `&part=${encodeURIComponent(part)}`}`, DailyResponseSchema, signal)
        .then((r) => {
          setDay(r.days.find((d) => d.date === sel) ?? r.days[0] ?? null);
          setError(null);
        })
        .catch((e: unknown) => {
          if (!signal?.aborted) setError(e instanceof Error ? e.message : "Xatolik");
        })
        .finally(() => setLoading(false)),
    [projectId, sel, part],
  );

  useEffect(() => {
    const ctl = new AbortController();
    void load(ctl.signal);
    return () => ctl.abort();
  }, [load, refreshKey]);

  // Jonli: project.updated (xulosa yozilganda ham keladi) -> qayta o'qish
  useLive(
    (type, payload) => {
      if (type === "project.updated" && (payload as { project?: { id?: string } } | null)?.project?.id === projectId) void load();
    },
    () => undefined,
  );

  // Buyruq yakunlansa (xulosa tayyor) qayta o'qiymiz
  useEffect(() => {
    if (cmd && cmd.status !== lastStatus.current) {
      lastStatus.current = cmd.status;
      if (cmd.status === "done") void load();
    }
  }, [cmd, load]);

  const view = useMemo(() => (day ? buildDailyView(day) : null), [day]);
  const choices = useMemo(() => dayChoices(today), [today]);
  const busy = api.busy || isInFlight(cmd);

  async function summarize() {
    setSumError(null);
    try {
      const c = await api.summarize(sel, part);
      setCmdId(c.id);
    } catch (e) {
      setSumError(e instanceof Error ? e.message : "Xatolik");
    }
  }

  return (
    <div className="flex flex-wrap items-start gap-4">
      <div className="flex min-w-0 flex-[999_1_560px] flex-col gap-3">
        <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Kun tanlash">
          {choices.map((d) => (
            <button key={d.date} type="button" className={`seg ${sel === d.date ? "on" : ""}`} style={{ height: 30, padding: "0 12px", background: sel === d.date ? undefined : "var(--s3)" }} aria-pressed={sel === d.date} onClick={() => setDate(d.date)}>
              {d.label}
            </button>
          ))}
          <label className="ml-1 flex items-center gap-1.5 text-xs text-mu">
            Sana
            <input type="date" className="sel" value={sel} max={today} onChange={(e) => e.target.value && setDate(e.target.value)} aria-label="Sana tanlash" />
          </label>
        </div>
        {error && (
          <div role="alert" className="rounded-lg bg-red-bg px-3 py-2 text-xs text-red">
            {error}
          </div>
        )}
        <div className="card overflow-x-auto">
          <div className="min-w-[760px]">
            <div className="lbl flex gap-3 border-b border-bd px-4 py-2.5">
              <span className="w-24">Vaqt</span>
              <span className="flex-1">Vazifa</span>
              <span className="w-[60px] text-right">Sessiya</span>
              <span className="w-[120px] text-right">Reja / haqiqiy</span>
              <span className="w-[70px] text-right">Token</span>
              <span className="w-[120px]">Baho</span>
            </div>
            {loading && <div className="sk m-4 h-10" aria-busy="true" />}
            {!loading && view && view.rows.length === 0 && <p className="m-0 px-4 py-4 text-mu">{dayLabel(sel, today)}: bu kunda vazifa bo&apos;yicha faollik yo&apos;q.</p>}
            {view?.rows.map((r) => (
              <div key={r.key} className="flex items-start gap-3 border-t border-bd px-4 py-[11px]" data-testid="daily-row">
                <span className="mono w-24 text-xs text-mu">{r.time}</span>
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="font-medium">
                    <span className="mono text-[11px] text-mu">{displayKey(r.key)}</span> {r.title}
                  </span>
                </div>
                <span className="mono w-[60px] text-right text-xs text-mu">{r.sessions}</span>
                <span className="mono w-[120px] text-right text-xs">
                  <span className="text-mu">{r.planText}</span> / <span className={RATIO_FG[r.ratioColor]}>{r.actualText}</span>
                </span>
                <span className="mono w-[70px] text-right text-xs text-mu">{r.tokens}</span>
                <span className="flex w-[120px] flex-col gap-0.5">
                  <span className="text-yel" style={{ letterSpacing: 1 }}>
                    {r.scoreStars || "—"}
                  </span>
                  {r.scoreReason && <span className="text-[11px] text-mu">{r.scoreReason}</span>}
                </span>
              </div>
            ))}
          </div>
        </div>
        {view && view.closedTitles.length > 0 && (
          <div className="card px-4 py-3 text-xs text-mu" data-testid="closed-tasks">
            <b className="text-tx">Shu kuni yopilgan:</b> {view.closedTitles.map((t) => `${t.key}${t.title ? ` ${t.title}` : ""}`).join(" · ")}
          </div>
        )}
      </div>

      <aside className="card flex flex-[1_1_280px] flex-col gap-3 p-4" aria-label="Kun xulosasi">
        <span className="lbl">Kun xulosasi · {dayLabel(sel, today)}</span>
        <div className="grid grid-cols-2 gap-2.5">
          <Stat v={view ? String(view.closed) : "…"} l="vazifa yopildi" />
          <Stat v={view?.sessionTime ?? "…"} l="sessiya vaqti" />
          <Stat v={view?.tokens ?? "…"} l="token" />
          <Stat v={view?.avgScore ?? "—"} l="o'rtacha baho" color={view?.avgScore ? "var(--yel)" : undefined} />
        </div>
        <div className="flex flex-col gap-1.5 rounded-lg bg-s2 px-3 py-2.5" data-testid="day-summary">
          <b className="text-xs">{summaryHeading(part)}</b>
          {view?.summary ? (
            <span className="whitespace-pre-wrap text-xs text-mu">{view.summary.text}</span>
          ) : view?.empty ? (
            <span className="text-xs text-mu">Bu kunda faollik yo&apos;q: xulosa yaratib bo&apos;lmaydi.</span>
          ) : (
            <span className="text-xs text-mu">{part ? "Bu qism uchun kun xulosasi hali yaratilmagan." : "Bu kun uchun xulosa hali yaratilmagan."}</span>
          )}
          {cmd && <CommandProgress command={cmd} />}
          {sumError && (
            <span role="alert" className="text-xs text-red" data-testid="summary-error">
              {sumError}
            </span>
          )}
          <button type="button" className="btn btn-pri self-start" disabled={busy || !!writeReason || !view || view.empty} title={writeReason ?? (view?.empty ? "Faollik yo'q" : undefined)} onClick={() => void summarize()}>
            {busy ? "Yaratilmoqda…" : view?.summary ? "Xulosani qayta yaratish" : "Xulosa yaratish"}
          </button>
          {writeReason && <span className="text-[11px] text-org">{writeReason}</span>}
        </div>
        <span className="text-[11px] text-fa">Baho avtomatik: reja va haqiqiy vaqt farqi, yopilganligi, token sarfi (Claude haiku). Mashinaga faqat statistika yuboriladi, kod emas.{part ? " Qism tanlangan: xulosa faqat shu qism vazifalari bo'yicha va alohida saqlanadi (commit sarlavhalari kirmaydi)." : ""}</span>
      </aside>
    </div>
  );
}

function Stat({ v, l, color }: { v: string; l: string; color?: string }) {
  return (
    <div>
      <div className="mono text-xl font-semibold" style={{ color }}>
        {v}
      </div>
      <span className="text-xs text-mu">{l}</span>
    </div>
  );
}
