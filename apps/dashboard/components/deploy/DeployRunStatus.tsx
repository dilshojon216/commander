import { StepsTable } from "./DeployHistoryTable";
import { TONE_CLASS, summaryHeadline, summaryRows } from "@/lib/deploy-view";
import type { RunProgress } from "@/lib/deploy-view";

interface Props {
  title: string;
  progress: RunProgress;
  /** `review.required` bo'lsa dashboard'da tasdiqlash (aks holda Telegram). */
  onConfirm: (() => void) | null;
  onCancel: (() => void) | null;
  busy: boolean;
  message: string | null;
}

/** Boshlangan deploy/rollback holati: tasdiq -> bajarilmoqda -> natija xulosasi. Jonli chiqishni chaqiruvchi qo'shadi. */
export function DeployRunStatus({ title, progress, onConfirm, onCancel, busy, message }: Props) {
  const tone = progress.phase === "failed" ? "bg-red-bg text-red" : progress.phase === "done" ? "bg-grn-bg text-grn" : progress.phase.startsWith("confirm") ? "bg-yel-bg text-yel" : "bg-blue-bg text-blue";
  const head = progress.summary ? summaryHeadline(progress.summary) : null;
  return (
    <div className="flex flex-col gap-2" data-testid="deploy-run-status" data-phase={progress.phase}>
      <div role="status" aria-live="polite" className={`flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg px-3 py-2 text-xs ${tone}`}>
        <span className="font-semibold">{title}:</span>
        <span>{progress.label}</span>
        {progress.error && <span data-testid="deploy-run-error">{progress.error}</span>}
        {progress.phase.startsWith("confirm") && onCancel && (
          <button type="button" className="btn btn-no ml-auto" disabled={busy} onClick={onCancel} data-testid="deploy-cancel">
            Bekor qilish
          </button>
        )}
        {progress.phase === "confirm_dashboard" && onConfirm && (
          <button type="button" className="btn btn-ok" disabled={busy} onClick={onConfirm} data-testid="deploy-confirm-reviewed">
            Ko&apos;rib chiqdim, tasdiqlash
          </button>
        )}
      </div>
      {message && (
        <span role="status" className="text-xs text-mu">
          {message}
        </span>
      )}
      {head && progress.summary && (
        <div className="flex flex-col gap-1.5" data-testid="deploy-summary">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className={`pill ${TONE_CLASS[head.badge.tone]}`} data-testid="deploy-outcome">
              {head.badge.label}
            </span>
            {head.detail && <span className="text-mu">{head.detail}</span>}
          </div>
          <StepsTable rows={summaryRows(progress.summary)} />
        </div>
      )}
    </div>
  );
}
