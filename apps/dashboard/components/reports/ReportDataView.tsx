import type { ReportData, ReportSection } from "@commander/contracts";
import { COST_LABEL, COST_NOTE, limitsView, modelBars, sectionView, sortSections } from "@/lib/reports-view";

/** Bitta bo'lim (jami yoki loyiha). Server/klient: faqat ko'rinish. */
export function ReportSectionView({ section, heading }: { section: ReportSection; heading: string }) {
  const v = sectionView(section);
  const models = modelBars(section.models);
  return (
    <section className="card flex flex-col gap-3 p-4" aria-label={heading} data-testid="report-section">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="m-0 text-sm font-semibold">{heading}</h2>
        <span className="pill bg-s3 text-mu" title="Jami vaznli sarfdagi ulush">
          limit ulushi {v.limitShare}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-6">
        {v.stats.map((s) => (
          <div key={s.label} className="flex flex-col gap-1 rounded-lg bg-s2 px-3 py-2.5" title={s.hint}>
            <span className="lbl">{s.label}</span>
            <span className="mono text-base font-semibold">{s.value}</span>
            {s.hint && <span className="text-[11px] text-fa">{s.hint}</span>}
          </div>
        ))}
      </div>

      {v.plan && <span className="text-xs text-mu">{v.plan}</span>}

      {v.closed.length > 0 && (
        <div className="flex flex-col gap-1">
          <span className="lbl">Yopilgan vazifalar</span>
          <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
            {v.closed.map((t) => (
              <li key={t.key}>
                <span className="mono text-mu">{t.key}</span> {t.title ?? "Vazifa"}
              </li>
            ))}
          </ul>
        </div>
      )}

      {v.topTasks.length > 0 && (
        <div className="flex flex-col gap-1">
          <span className="lbl">Eng ko&apos;p sarflangan vazifalar</span>
          {v.topTasks.map((t) => (
            <div key={t.key} className="flex justify-between gap-2">
              <span className="min-w-0 truncate">
                <span className="mono text-mu">{t.key}</span> {t.title ?? "Vazifa"}
              </span>
              <span className="mono shrink-0 text-mu">
                {t.tokens} · {t.cost}
              </span>
            </div>
          ))}
        </div>
      )}

      {models.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <span className="lbl">Model aralashmasi</span>
          {models.map((m) => (
            <div key={m.model} className="flex flex-col gap-1" data-testid="model-bar">
              <div className="flex justify-between gap-2">
                <span className="mono min-w-0 truncate">{m.model}</span>
                <span className="mono shrink-0 text-mu">
                  {m.label} · {m.cost}
                </span>
              </div>
              <div className="h-2 rounded bg-s3">
                <div className="h-2 rounded bg-blue" style={{ width: `${m.width}%` }} />
              </div>
            </div>
          ))}
        </div>
      )}

      {v.summaries.length > 0 && (
        <div className="flex flex-col gap-1">
          <span className="lbl">Kunlik xulosalar</span>
          {v.summaries.map((s, i) => (
            <p key={`${i}-${s.slice(0, 16)}`} className="m-0 text-xs text-mu">
              {s}
            </p>
          ))}
        </div>
      )}
    </section>
  );
}

/** Hisobot tarkibi: jami, loyihalar, tavsiyalar, limitlar (manba bilan). */
export function ReportDataView({ data }: { data: ReportData }) {
  const limits = limitsView(data.limits);
  return (
    <div className="flex flex-col gap-4" data-testid="report-data">
      <ReportSectionView section={data.total} heading="Jami" />
      {sortSections(data.projects).map((p) => (
        <ReportSectionView key={p.projectId ?? p.name} section={p} heading={p.name} />
      ))}

      <section className="card flex flex-col gap-2 p-4" aria-label="Tavsiyalar" data-testid="report-recommendations">
        <h2 className="m-0 text-sm font-semibold">Tavsiyalar</h2>
        {data.recommendations.length === 0 ? (
          <span className="text-mu">Tavsiya yo&apos;q.</span>
        ) : (
          <ul className="m-0 flex list-disc flex-col gap-1 pl-5">
            {data.recommendations.map((r, i) => (
              <li key={`${i}-${r.slice(0, 16)}`}>{r}</li>
            ))}
          </ul>
        )}
      </section>

      {limits && (
        <section className="card flex flex-col gap-2 p-4" aria-label="Limitlar" data-testid="report-limits">
          <h2 className="m-0 text-sm font-semibold">
            Limitlar <span className="pill bg-s3 text-mu">{limits.source}</span>
          </h2>
          {limits.rows.length === 0 ? (
            <span className="text-mu">Limit ma&apos;lumoti manbasiz: ko&apos;rsatilmaydi.</span>
          ) : (
            <div className="flex flex-wrap gap-4">
              {limits.rows.map((r) => (
                <span key={r.label}>
                  <span className="text-mu">{r.label}:</span> <b className="mono">{r.value}</b>
                </span>
              ))}
            </div>
          )}
        </section>
      )}
      <span className="text-[11px] text-fa">
        {COST_LABEL}: {COST_NOTE}.
      </span>
    </div>
  );
}
