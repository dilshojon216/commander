import type { WeeklyPace } from "@commander/contracts";
import { describePace } from "@/lib/pace-view";

const COLOR_VAR = { grn: "var(--grn)", yel: "var(--yel)", red: "var(--red)", mu: "var(--mu)" } as const;

/** "Bugungi ulush" qatori (6.12): bar + holat. Taxmin: kulrang, shtrixli chiziq, "≈" (CLAUDE.md #6). */
export function PaceBar({ pace }: { pace: WeeklyPace }) {
  const v = describePace(pace);
  const est = v.tone === "estimate";
  return (
    <div className={`flex min-w-0 flex-col gap-1.5 ${est ? "opacity-80" : ""}`} data-testid="pace" data-tone={v.tone} data-status={v.status} title={v.detail}>
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="mono text-[13px] font-semibold" style={{ color: est ? "var(--mu)" : undefined }} data-testid="pace-share">
          {v.shareText}
        </span>
        <span className="pill" style={{ height: 18, fontSize: 11, color: COLOR_VAR[v.statusColor] }} data-testid="pace-status">
          {v.statusText}
        </span>
        {est && (
          <span className="pill text-mu" style={{ height: 18, fontSize: 11, border: "1px dashed var(--mu)" }}>
            taxmin
          </span>
        )}
      </div>
      <div
        className="relative h-1.5 overflow-hidden rounded-md bg-s3"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(v.barPct)}
        aria-label={`${v.shareText} (${v.statusText})${est ? " (taxmin)" : ""}`}
      >
        <div className={`h-1.5 ${est ? "hatch" : ""}`} style={{ width: `${v.barPct}%`, background: est ? undefined : COLOR_VAR[v.statusColor] }} />
      </div>
      <span className="text-xs text-mu" data-testid="pace-expected">
        {v.expectedText}
      </span>
      {v.forecastText && (
        <span className={`text-xs font-medium ${v.forecastWarn ? "text-yel" : "text-mu"}`} data-testid="pace-forecast">
          {v.forecastText}
        </span>
      )}
      {v.sourceNote && <span className="text-[12px] text-fa">{v.sourceNote}</span>}
      {v.gateNote && (
        <span className="text-[12px] text-yel" data-testid="pace-gate">
          {v.gateNote}
        </span>
      )}
    </div>
  );
}
