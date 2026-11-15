"use client";

import type { HealthContainer, HealthSeriesPoint, HealthStatus } from "@commander/contracts";
import { CONTAINER_PILL_CLASS, STATUS_LABEL, STATUS_PILL, TONE_BAR, containerPill, formatPct, pctTone, pointsToPath, sortContainers, sparkPoints } from "@/lib/health-view";

export function HealthStatusPill({ status }: { status: HealthStatus }) {
  return (
    <span className={`pill ${STATUS_PILL[status]}`} data-testid="health-status" data-status={status}>
      {STATUS_LABEL[status]}
    </span>
  );
}

/** Gorizontal foiz chizig'i (rang: chegaralar bo'yicha). */
export function HealthBar({ label, pct, detail, warnAt, critAt }: { label: string; pct: number | null; detail?: string; warnAt?: number; critAt?: number }) {
  const tone = pctTone(pct, warnAt, critAt);
  return (
    <div className="flex flex-col gap-1" data-testid="health-bar" data-tone={tone}>
      <div className="flex justify-between gap-2 text-xs">
        <span className="text-mu">{label}</span>
        <span className="mono">
          {formatPct(pct)}
          {detail ? <span className="text-fa"> · {detail}</span> : null}
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-s3" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct ?? undefined}>
        <div className="h-full rounded-full" style={{ width: `${Math.min(100, Math.max(0, pct ?? 0))}%`, background: TONE_BAR[tone] }} />
      </div>
    </div>
  );
}

/** Kichik chiziqli grafik (0..100%). Ma'lumot kam bo'lsa bo'sh joy ko'rsatadi. */
export function Sparkline({ series, pick, label, width = 220, height = 40, color = "var(--blue)", fromTs, toTs }: { series: HealthSeriesPoint[]; pick: (p: HealthSeriesPoint) => number | null; label: string; width?: number; height?: number; color?: string; fromTs?: number; toTs?: number }) {
  const pts = sparkPoints(series, pick, width, height, fromTs, toTs);
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="block w-full" style={{ height }} role="img" aria-label={label} preserveAspectRatio="none" data-testid="sparkline" data-points={pts.length}>
      <line x1="0" y1={height} x2={width} y2={height} stroke="var(--bd)" strokeWidth="1" />
      {pts.length >= 2 ? <path d={pointsToPath(pts)} fill="none" stroke={color} strokeWidth="1.5" vectorEffect="non-scaling-stroke" strokeLinejoin="round" /> : <text x="4" y={height / 2} fontSize="10" fill="var(--fa)">ma&apos;lumot yetarli emas</text>}
    </svg>
  );
}

export function ContainerList({ containers, available, reason, limit }: { containers: HealthContainer[]; available: boolean; reason?: string; limit?: number }) {
  if (!available) {
    return (
      <div className="text-xs text-fa" data-testid="docker-unavailable">
        Docker: {reason === "not_installed" ? "o'rnatilmagan" : reason === "no_access" ? "ruxsat yo'q (agentd foydalanuvchisi docker guruhida emas?)" : "tekshirib bo'lmadi"}
      </div>
    );
  }
  if (containers.length === 0) return <div className="text-xs text-fa">Konteyner yo&apos;q</div>;
  const list = sortContainers(containers);
  const shown = limit ? list.slice(0, limit) : list;
  return (
    <ul className="flex flex-col gap-1" data-testid="container-list">
      {shown.map((c) => {
        const p = containerPill(c);
        return (
          <li key={c.name} className="flex items-center justify-between gap-2 text-xs" title={`${c.image} · ${c.status}`}>
            <span className="mono min-w-0 truncate">{c.name}</span>
            <span className="flex shrink-0 items-center gap-1.5">
              {c.restartCount > 0 ? <span className="mono text-fa">↻{c.restartCount}</span> : null}
              <span className={`pill ${CONTAINER_PILL_CLASS[p.tone]}`} style={{ height: 18 }} data-tone={p.tone}>
                {p.label}
              </span>
            </span>
          </li>
        );
      })}
      {limit && list.length > limit ? <li className="text-[11px] text-fa">+{list.length - limit} ta yana</li> : null}
    </ul>
  );
}

export function FailedUnits({ units }: { units: string[] }) {
  if (units.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5" data-testid="failed-units">
      <span className="text-xs text-mu">Muvaffaqiyatsiz unitlar:</span>
      {units.map((u) => (
        <span key={u} className="pill bg-red-bg text-red mono" style={{ height: 18 }}>
          {u}
        </span>
      ))}
    </div>
  );
}
