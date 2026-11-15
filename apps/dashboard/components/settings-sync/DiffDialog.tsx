"use client";

import type { ConfigDiffResponse, ConfigMachineState, ConfigMode, ConfigPlanEntry } from "@commander/contracts";
import { useEffect, useState } from "react";
import { Dialog } from "@/components/ui/Dialog";
import { IconClose, IconSpinner } from "@/components/ui/icons";
import { DIFF_LINE_CLASS, MIRROR_WARNING, MODE_LABEL, groupPlanEntries, parseDiff, planHasChanges, planSummaryText, settingsPlanLines } from "@/lib/config-view";
import type { Result } from "./useConfigSync";

const TONE: Record<string, string> = { blue: "bg-blue-bg text-blue", yel: "bg-yel-bg text-yel", grn: "bg-grn-bg text-grn", red: "bg-red-bg text-red", gray: "bg-gray-bg text-mu" };

/** Dry-run natijasi: xulosa, fayllar bo'yicha unified diff (+/- ranglangan), settings rejasi. Faqat ko'rsatadi, hech narsa yozmaydi. */
export function DiffBody({ res }: { res: ConfigDiffResponse }) {
  const { plan } = res;
  const groups = groupPlanEntries(plan.entries);
  const sLines = plan.settings ? settingsPlanLines(plan.settings) : [];
  return (
    <div className="flex flex-col gap-3" data-testid="diff-body">
      <div className="text-sm" data-testid="plan-summary">
        <b>{res.profile.name} v{res.profile.version}</b> · {planSummaryText(plan.summary)}
      </div>
      {plan.truncated && <div className="rounded-md bg-yel-bg px-3 py-2 text-xs text-yel">Diff hajmi chegarasi sabab ba&apos;zi fayllar diff&apos;i qisqartirilgan yoki tushirilgan.</div>}
      {groups.length === 0 && <div className="text-xs text-mu">Reja bo&apos;sh</div>}
      {groups.map((g) => (
        <section key={g.action} className="flex flex-col gap-1" aria-label={g.label}>
          <span className={`pill w-fit ${TONE[g.tone]}`}>
            {g.label} · {g.entries.length}
          </span>
          {g.entries.map((e) => (
            <EntryRow key={`${e.action}:${e.path}`} e={e} />
          ))}
        </section>
      ))}
      {plan.settings && (
        <section className="flex flex-col gap-1" aria-label="settings.json">
          <span className="lbl">settings.json {plan.settings.changed ? "" : "(o'zgarmaydi)"}</span>
          {sLines.map((l) => (
            <div key={`${l.kind}:${l.text}`} className={`mono truncate rounded px-2 text-xs ${l.kind === "add" ? DIFF_LINE_CLASS.add : DIFF_LINE_CLASS.del}`} title={l.text}>
              {l.kind === "add" ? "+ " : "- "}
              {l.text}
            </div>
          ))}
          {plan.settings.refused.length > 0 && (
            <ul className="m-0 list-none p-0 text-xs text-yel">
              {plan.settings.refused.map((r) => (
                <li key={r}>Rad etildi: {r}</li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}

function EntryRow({ e }: { e: ConfigPlanEntry }) {
  const lines = e.diff ? parseDiff(e.diff) : [];
  const head = (
    <>
      <span className="mono text-xs">{e.path}</span>
      {e.reason && <span className="text-xs text-mu"> · {e.reason}</span>}
    </>
  );
  if (lines.length === 0) return <div className="px-1">{head}</div>;
  return (
    <details className="rounded-md border border-bd" data-testid="plan-entry">
      <summary className="cursor-pointer px-2 py-1">{head}</summary>
      <pre className="mono m-0 max-h-80 overflow-auto p-0 text-xs leading-5" aria-label={`${e.path} diff`}>
        {lines.map((l, i) => (
          <div key={i} className={`whitespace-pre-wrap break-words px-2 ${DIFF_LINE_CLASS[l.kind]}`} data-kind={l.kind}>
            {l.text || " "}
          </div>
        ))}
      </pre>
      {e.diffTruncated && <div className="px-2 pb-1 text-xs text-yel">Diff qisqartirilgan</div>}
    </details>
  );
}

/** "Farqni ko'rish" oynasi: ochilganda va rejim o'zgarganda dry-run so'raydi (45 s gacha). */
export function DiffDialog({
  machine,
  profileLabel,
  mode,
  onMode,
  run,
  onResult,
  onProceed,
  canApply,
  onClose,
}: {
  machine: ConfigMachineState;
  profileLabel: string;
  mode: ConfigMode;
  onMode: (m: ConfigMode) => void;
  run: (mode: ConfigMode) => Promise<Result<ConfigDiffResponse>>;
  onResult: (res: ConfigDiffResponse | null, mode: ConfigMode) => void;
  onProceed: () => void;
  /** Yozish ruxsati bor (allowWrite, lockdown yo'q ...) */
  canApply: { enabled: boolean; reason: string | null };
  onClose: () => void;
}) {
  const [state, setState] = useState<{ mode: ConfigMode; result: Result<ConfigDiffResponse> } | null>(null);

  useEffect(() => {
    let live = true;
    run(mode).then((result) => {
      if (!live) return;
      setState({ mode, result });
      onResult(result.ok ? result.value : null, mode);
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- faqat rejim o'zgarganda qayta so'raymiz
  }, [mode]);

  const loading = !state || state.mode !== mode;
  const res = !loading && state.result.ok ? state.result.value : null;
  const hasChanges = res ? planHasChanges(res.plan.summary) || !!res.plan.settings?.changed : false;

  return (
    <Dialog labelledBy="diff-title" onClose={onClose} maxWidth={820} top={30}>
      <div className="flex items-center gap-2 border-b border-bd px-4 py-3">
        <h2 id="diff-title" className="m-0 flex-1 text-base font-semibold">
          Farq: {machine.name} · {profileLabel}
        </h2>
        <button type="button" className="btn" aria-label="Yopish" onClick={onClose}>
          <IconClose size={14} />
        </button>
      </div>
      <div className="flex max-h-[70vh] flex-col gap-3 overflow-auto px-4 py-3">
        <label className="flex flex-wrap items-center gap-2 text-xs text-mu">
          Rejim
          <select className="btn" value={mode} onChange={(e) => onMode(e.target.value as ConfigMode)} aria-label="Rejim">
            {(["merge", "mirror"] as const).map((m) => (
              <option key={m} value={m}>
                {MODE_LABEL[m]}
              </option>
            ))}
          </select>
        </label>
        {mode === "mirror" && (
          <div role="note" className="rounded-md bg-yel-bg px-3 py-2 text-xs text-yel" data-testid="mirror-warning">
            {MIRROR_WARNING}
          </div>
        )}
        {loading ? (
          <div role="status" className="flex items-center gap-2 text-sm text-mu" aria-busy="true">
            <IconSpinner size={14} /> Mashinadan reja olinmoqda (45 s gacha)…
          </div>
        ) : state.result.ok ? (
          <DiffBody res={state.result.value} />
        ) : (
          <div role="alert" className="rounded-md bg-red-bg px-3 py-2 text-sm text-red">
            {state.result.error}
          </div>
        )}
      </div>
      <div className="flex flex-wrap items-center justify-end gap-2 border-t border-bd px-4 py-3">
        {res && !hasChanges && <span className="mr-auto text-xs text-grn">Mashina profilga mos: o&apos;zgarish yo&apos;q</span>}
        {res && hasChanges && !canApply.enabled && canApply.reason && <span className="mr-auto text-xs text-yel">{canApply.reason}</span>}
        <button type="button" className="btn" onClick={onClose}>
          Yopish
        </button>
        <button type="button" className="btn btn-pri" disabled={!res || !hasChanges || !canApply.enabled} title={canApply.reason ?? undefined} onClick={onProceed}>
          Qo&apos;llashga o&apos;tish
        </button>
      </div>
    </Dialog>
  );
}
