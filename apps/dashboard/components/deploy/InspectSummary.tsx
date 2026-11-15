import { TONE_CLASS } from "@/lib/deploy-view";
import type { InspectModel } from "@/lib/deploy-view";

/** Tekshiruv natijasining sarlavhasi: HEAD, ifloslik, retsept xeshi (nusxalanadi), yaroqlilik, muammolar, yo'riqnomalar. */
export function InspectSummary({ model, onCopyHash }: { model: InspectModel; onCopyHash: (hash: string) => void }) {
  return (
    <div className="flex flex-col gap-2" data-testid="inspect-summary">
      <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        <dt className="text-mu">HEAD</dt>
        <dd className="mono m-0" title={model.commit} data-testid="inspect-commit">
          {model.commit8}
          {model.branch ? ` · ${model.branch}` : ""}
          {model.dirty && (
            <span className={`pill ml-2 ${TONE_CLASS.warn}`} data-testid="inspect-dirty">
              commit qilinmagan o&apos;zgarish bor
            </span>
          )}
        </dd>
        <dt className="text-mu">Retsept xeshi</dt>
        <dd className="mono m-0 flex flex-wrap items-center gap-2" data-testid="inspect-hash">
          <span title={model.recipeHash ?? undefined}>{model.recipeHash8}</span>
          {model.recipeHash && (
            <button type="button" className="btn" onClick={() => onCopyHash(model.recipeHash as string)} aria-label="To'liq xeshni nusxalash" data-testid="copy-hash">
              Nusxalash
            </button>
          )}
        </dd>
        <dt className="text-mu">Retsept</dt>
        <dd className="m-0">
          <span className={`pill ${model.valid ? TONE_CLASS.ok : TONE_CLASS.err}`} data-testid="inspect-valid">
            {model.valid ? "yaroqli" : "yaroqsiz"}
          </span>
        </dd>
      </dl>
      {model.notices.map((n) => (
        <div key={n.text} role="note" className={`rounded-md px-3 py-2 text-xs ${TONE_CLASS[n.tone]}`} data-testid="inspect-notice">
          {n.text}
        </div>
      ))}
      {model.issues.length > 0 && (
        <ul className="m-0 flex list-none flex-col gap-0.5 rounded-md bg-yel-bg px-2.5 py-2 text-xs text-tx" aria-label="Retsept muammolari" data-testid="inspect-issues">
          {model.issues.map((s, i) => (
            <li key={i}>{s}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
