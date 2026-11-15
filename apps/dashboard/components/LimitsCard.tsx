import type { LimitWindowView, WeeklyPace } from "@commander/contracts";
import { PaceBar } from "@/components/PaceBar";
import { FIVE_HOUR_MS, LIMIT_COLOR_VAR, describeLimitDisplay, hasNoWindowData } from "@/lib/limits-view";
import { describeForecast } from "@/lib/queue-view";

/**
 * Limit oynasi kartasi (4 holat: rasmiy / taxmin / eskirgan / yangilandi). CLAUDE.md #6: taxmin hech qachon
 * rasmiy raqamdek ko'rinmaydi: doim "≈", kulrang raqam, shtrixli chiziq va punktir "taxmin" yorlig'i.
 * `now === 0`: hali hydrate bo'lmagan (SSR), vaqtga bog'liq matnlar placeholder.
 */
export function LimitWindowCard({ title, window: w, now, compact = false }: { title: string; window: LimitWindowView | null; now: number; compact?: boolean }) {
  const ready = now !== 0;
  const d = describeLimitDisplay(w, now || Date.parse(w?.observedAt ?? "") || 0);
  const big = compact ? "text-2xl" : "text-[28px]";
  const forecast = ready ? describeForecast(w, now) : null;
  return (
    <div className={`flex min-w-0 flex-col gap-2 ${d.dim ? "opacity-60" : ""}`} data-testid={`limit-${title}`} data-tone={d.tone} title={d.note ?? undefined}>
      <div className="flex items-center gap-2">
        <span className="lbl">{title}</span>
        {d.tag && (
          <span
            className={`pill ${d.tag.dashed ? "text-mu" : "bg-blue-bg text-blue"}`}
            style={{ height: 18, fontSize: 11, ...(d.tag.dashed ? { border: "1px dashed var(--mu)" } : {}) }}
          >
            {d.tag.text}
          </span>
        )}
      </div>
      <div className="flex items-baseline gap-2">
        <span className={`mono ${big} font-semibold`} style={{ color: LIMIT_COLOR_VAR[d.valueColor] }} aria-label={`${title} sarfi ${d.valueText}`}>
          {d.valueText}
        </span>
        {d.extra && <span className="font-medium text-grn">{d.extra}</span>}
      </div>
      <div
        className="relative h-1.5 overflow-hidden rounded-md bg-s3"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(d.barPct)}
        aria-label={`${title}: ${d.valueText}${d.tone === "estimate" || d.tone === "reset" ? " (taxmin)" : ""}`}
      >
        <div
          className={`h-1.5 ${d.barKind === "hatch" ? "hatch" : ""}`}
          style={{ width: `${d.barPct}%`, background: d.barKind === "hatch" ? undefined : LIMIT_COLOR_VAR[d.barColor] }}
        />
        {d.thresholds && (
          <>
            <div className="absolute top-0 h-1.5 w-px bg-yel" style={{ left: "80%" }} />
            <div className="absolute top-0 h-1.5 w-px bg-red" style={{ left: "95%" }} />
          </>
        )}
      </div>
      <span className="text-xs text-mu" suppressHydrationWarning>
        {ready ? d.resetLine : "…"}
      </span>
      <span className="text-[12px] text-fa" suppressHydrationWarning>
        {ready ? d.observedLine : "…"}
      </span>
      {forecast && (
        <span className={`text-xs font-medium ${forecast.warn ? "text-yel" : "text-mu"}`} title={forecast.detail} data-testid={`forecast-${title}`} suppressHydrationWarning>
          {forecast.text}
        </span>
      )}
    </div>
  );
}

/** Oyna ma'lumoti yo'q (masalan tarifda 5 soatlik oyna yo'q): soxta "≈0%" o'rniga xira izoh. */
function NoWindowData({ title, text }: { title: string; text: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-2 opacity-70" data-testid={`limit-${title}`} data-tone="none">
      <span className="lbl">{title}</span>
      <span className="text-xs text-mu" data-testid="limit-empty">
        {text}
      </span>
    </div>
  );
}

export function LimitsCard({ fiveHour, sevenDay, now, pace }: { fiveHour: LimitWindowView | null; sevenDay: LimitWindowView | null; now: number; pace?: WeeklyPace | null }) {
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-4 max-[520px]:grid-cols-1">
        {hasNoWindowData(fiveHour, FIVE_HOUR_MS, now) ? <NoWindowData title="5 soat" text="5 soatlik limit ma'lumoti yo'q" /> : <LimitWindowCard title="5 soat" window={fiveHour} now={now} />}
        <LimitWindowCard title="Haftalik" window={sevenDay} now={now} />
      </div>
      {pace && <PaceBar pace={pace} />}
    </div>
  );
}
