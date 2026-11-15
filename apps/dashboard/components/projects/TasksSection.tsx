import type { ProjectTaskStatus } from "@commander/contracts";
import type { TasksView } from "@/lib/tasks-view";

const META: Record<ProjectTaskStatus, { icon: string; fg: string; bg: string; text: string }> = {
  done: { icon: "✓", fg: "text-grn", bg: "bg-grn-bg", text: "text-mu" },
  doing: { icon: "◐", fg: "text-blue", bg: "bg-blue-bg", text: "text-tx" },
  todo: { icon: "○", fg: "text-mu", bg: "bg-gray-bg", text: "text-tx" },
  unknown: { icon: "?", fg: "text-yel", bg: "bg-yel-bg", text: "text-tx" },
};

const COLS = "grid grid-cols-[18px_44px_minmax(220px,1fr)_104px_84px_96px_72px_60px_84px] items-center gap-2.5";

/** Loyiha rejasi: faza guruhlari, progress, har vazifa bo'yicha token/narx/vaqt/sessiya, "vazifasiz" qator. */
export function TasksSection({ view, file }: { view: TasksView; file: string }) {
  return (
    <section className="card overflow-hidden" aria-label="Reja">
      <div className="flex flex-wrap items-center gap-3 px-4 py-3.5">
        <h2 className="m-0 flex-1 text-sm font-semibold">
          Reja · <span className="mono font-medium">{file}</span>
        </h2>
        <span className="text-xs text-mu" data-testid="tasks-progress-text">
          {view.done} / {view.total} bajarildi
        </span>
        <div className="flex h-2 w-[220px] max-w-full overflow-hidden rounded bg-s3" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(view.donePct)} aria-label="Reja bajarilishi">
          <div className="bg-grn" style={{ width: `${view.donePct}%` }} />
          <div className="bg-blue" style={{ width: `${view.doingPct}%` }} />
        </div>
      </div>
      {view.coveredNote && <p className="m-0 border-t border-bd px-4 py-2 text-xs text-fa">{view.coveredNote}</p>}
      <div className="max-h-[560px] overflow-auto border-t border-bd">
        <div className="min-w-[860px]">
          <div className={`${COLS} lbl border-b border-bd px-4 py-2`}>
            <span />
            <span>№</span>
            <span>Vazifa</span>
            <span>Holat</span>
            <span className="text-right">Token</span>
            <span className="text-right">API ekv.</span>
            <span className="text-right">Faol vaqt</span>
            <span className="text-right">Sessiya</span>
            <span className="text-right">Oxirgi</span>
          </div>
          {view.groups.map((g, gi) => (
            <div key={`${g.phase}-${gi}`}>
              {g.phase && (
                <div className="flex items-center gap-2 border-b border-bd bg-s2 px-4 py-1.5 text-xs font-semibold text-mu" data-testid="task-phase">
                  <span className="flex-1">{g.phase}</span>
                  <span className="mono">
                    {g.done}/{g.total}
                  </span>
                </div>
              )}
              {g.tasks.map((t, i) => {
                const m = META[t.status];
                return (
                  <div key={`${t.key}-${i}`} className={`${COLS} border-b border-bd px-4 py-[9px]`} data-testid="task-row" data-status={t.status}>
                    <span className={m.fg} aria-hidden="true">
                      {m.icon}
                    </span>
                    <span className="mono truncate text-mu" title={t.key}>
                      {t.key}
                    </span>
                    <span className={`flex min-w-0 flex-wrap items-center gap-x-2 ${m.text}`}>
                      <span className="min-w-0 truncate" title={t.title}>
                        {t.title}
                      </span>
                      {t.badge && (
                        <span className="pill bg-gray-bg text-mu" style={{ height: 18, fontSize: 10, border: "1px dashed var(--mu)" }} title={t.badge.title}>
                          {t.badge.text}
                        </span>
                      )}
                    </span>
                    <span>
                      <span className={`pill ${m.fg} ${m.bg}`} style={{ height: 20 }}>
                        {t.statusLabel}
                      </span>
                    </span>
                    <span className="mono text-right" title={t.tokensTitle}>
                      {t.tokens}
                    </span>
                    <span className="mono text-right text-xs text-mu" title="Obuna uchun haqiqiy to'lov emas">
                      {t.cost}
                    </span>
                    <span className="mono text-right text-mu">{t.activeTime}</span>
                    <span className="mono text-right text-mu">{t.sessions}</span>
                    <span className="mono text-right text-mu" suppressHydrationWarning>
                      {t.lastActivity}
                    </span>
                  </div>
                );
              })}
            </div>
          ))}
          {view.other.map((o) => (
            <div key={`other-${o.key}`} className={`${COLS} border-b border-bd px-4 py-[9px]`} data-testid="task-other">
              <span className="text-yel" aria-hidden="true">
                ?
              </span>
              <span className="mono truncate text-mu">{o.key}</span>
              <span className="text-mu">TASKS.md&apos;da yo&apos;q vazifa (faollik bor)</span>
              <span />
              <span className="mono text-right">{o.tokens}</span>
              <span />
              <span />
              <span className="mono text-right text-mu">{o.sessions}</span>
              <span />
            </div>
          ))}
          {view.unattributed && (
            <div className={`${COLS} px-4 py-[9px]`} data-testid="task-unattributed">
              <span className="text-fa" aria-hidden="true">
                –
              </span>
              <span />
              <span className="italic text-mu">vazifasiz</span>
              <span />
              <span className="mono text-right">{view.unattributed.tokens}</span>
              <span className="mono text-right text-xs text-mu">{view.unattributed.cost}</span>
              <span />
              <span className="mono text-right text-mu">{view.unattributed.sessions}</span>
              <span />
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
