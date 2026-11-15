"use client";

import type { ProjectPartDto } from "@commander/contracts";
import { ALL_PARTS, doneSummaryView } from "@/lib/parts-view";
import type { PartTabView } from "@/lib/parts-view";

/** Loyiha qismlari (6.15): tab'lar (progress bilan) va tanlangan qism uchun "Bajarilganlar xulosasi". */
export function PartTabs({ tabs, active, onSelect }: { tabs: PartTabView[]; active: string; onSelect: (id: string) => void }) {
  return (
    <div className="flex flex-wrap gap-2" role="tablist" aria-label="Loyiha qismlari" data-testid="part-tabs">
      {tabs.map((t) => (
        <button
          key={t.id || "__root"}
          type="button"
          role="tab"
          aria-selected={active === t.id}
          data-testid={`part-tab-${t.id || "root"}`}
          onClick={() => onSelect(t.id)}
          className="card flex min-w-[140px] flex-col gap-1 px-3 py-2 text-left"
          style={{ cursor: "pointer", borderColor: active === t.id ? "var(--blue)" : undefined }}
        >
          <span className="text-[13px] font-semibold">{t.label}</span>
          <span className="mono text-[11px] text-mu">{t.progressText}</span>
          <span className="h-1 w-full overflow-hidden rounded bg-s3" aria-hidden="true">
            <span className="block h-full" style={{ width: `${t.pct ?? 0}%`, background: "var(--grn)" }} />
          </span>
        </button>
      ))}
    </div>
  );
}

export function PartSummary({ part }: { part: ProjectPartDto }) {
  const v = doneSummaryView(part);
  return (
    <section className="card flex flex-col gap-3 p-4" aria-label="Bajarilganlar xulosasi" data-testid="part-summary">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="m-0 text-sm font-semibold">Bajarilganlar xulosasi · {part.part === "" ? "Asosiy" : part.name}</h2>
        <span className="mono text-[11px] text-mu">{part.part === ALL_PARTS ? `${part.planFiles.length} ta reja fayli` : part.planFiles.join(", ") || "reja fayli yo'q"}</span>
      </div>
      <p className="m-0 text-[13px]">{v.headline}</p>
      <p className="m-0 text-xs text-mu">{v.stats}</p>
      {v.recent.length > 0 && (
        <div className="flex flex-col gap-1">
          <span className="lbl">Oxirgi bajarilganlar</span>
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {v.recent.map((r, i) => (
              <li key={`${r.key}-${i}`} className="flex gap-2 text-[13px]" data-testid="part-done-item">
                {r.date && <span className="mono w-[84px] shrink-0 text-[11px] text-mu">{r.date}</span>}
                <span className="mono text-[11px] text-mu">{r.key}</span>
                <span className="min-w-0 flex-1">{r.title}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {v.phases.length > 1 && (
        <div className="flex flex-col gap-1">
          <span className="lbl">Bo&apos;limlar bo&apos;yicha</span>
          {v.phases.map((f) => (
            <div key={f.label} className="flex items-center gap-2 text-xs">
              <span className="min-w-0 flex-1 truncate">{f.label}</span>
              <span className="mono text-mu">{f.text}</span>
              <span className="h-1 w-24 overflow-hidden rounded bg-s3" aria-hidden="true">
                <span className="block h-full" style={{ width: `${f.pct}%`, background: "var(--grn)" }} />
              </span>
            </div>
          ))}
        </div>
      )}
      {v.notes.map((n) => (
        <p key={n} className="m-0 text-[11px] text-org">
          {n}
        </p>
      ))}
    </section>
  );
}
