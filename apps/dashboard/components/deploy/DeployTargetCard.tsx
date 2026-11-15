import type { TargetCardModel } from "@/lib/deploy-view";
import { TONE_CLASS } from "@/lib/deploy-view";

interface Props {
  card: TargetCardModel;
  /** Umumiy to'siq (lockdown, token yo'q, boshqa deploy bajarilmoqda): tugmani o'chiradi. */
  globalBlock: string | null;
  onDeploy: (target: string) => void;
}

/**
 * Bitta deploy maqsadi (target): mashina, cwd, muddat, aniq buyruqlar, health, rollback. Buyruqlar FAQAT React matn tuguni sifatida
 * chiqariladi (`<pre>` ichida, HTML emas). Deploy tugmasi to'siq bo'lsa o'chiq va sabablar ko'rinadi.
 */
export function DeployTargetCard({ card, globalBlock, onDeploy }: Props) {
  const reasons = [...card.blockReasons, ...(globalBlock ? [globalBlock] : [])];
  const disabled = reasons.length > 0;
  return (
    <article className="card flex flex-col gap-2.5 p-3.5" aria-label={`Deploy maqsadi ${card.name}`} data-testid={`deploy-target-${card.name}`} data-can-deploy={!disabled}>
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="mono m-0 flex-1 text-sm font-semibold">{card.name}</h3>
        {card.badges.map((b) => (
          <span key={b.label} className={`pill ${TONE_CLASS[b.tone]}`} data-testid={b.label.startsWith("mashina mos emas") ? "machine-mismatch-badge" : b.label === "shell" ? "shell-badge" : undefined}>
            {b.label}
          </span>
        ))}
        <button type="button" className="btn btn-pri" disabled={disabled} title={disabled ? reasons[0] : `${card.name} maqsadiga deploy`} aria-describedby={disabled ? `deploy-why-${card.name}` : undefined} onClick={() => onDeploy(card.name)} data-testid={`deploy-btn-${card.name}`}>
          Deploy
        </button>
      </div>
      <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
        <dt className="text-mu">Mashina</dt>
        <dd className="mono m-0">{card.machine}</dd>
        <dt className="text-mu">Papka (cwd)</dt>
        <dd className="mono m-0 break-all">{card.cwd}</dd>
        <dt className="text-mu">Muddat</dt>
        <dd className="mono m-0">{card.timeoutSec} s</dd>
        <dt className="text-mu">Sog&apos;liq (health)</dt>
        <dd className="mono m-0 break-all">{card.healthText ?? "yo'q"}</dd>
        <dt className="text-mu">Rollback</dt>
        <dd className="m-0">{card.rollbackDefined ? "retseptda bor" : "yo'q"}</dd>
      </dl>
      <div className="flex flex-col gap-1">
        <span className="lbl">Bajariladigan buyruqlar</span>
        <pre className="mono m-0 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md border border-bd bg-s2 px-3 py-2.5 text-xs" data-testid={`deploy-plan-${card.name}`}>
          {card.plan}
        </pre>
      </div>
      {card.warnings.length > 0 && (
        <ul className="m-0 flex list-none flex-col gap-0.5 rounded-md bg-yel-bg px-2.5 py-2 text-xs text-yel" data-testid={`deploy-warnings-${card.name}`}>
          {card.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}
      {disabled && (
        <ul id={`deploy-why-${card.name}`} role="note" className="m-0 flex list-none flex-col gap-0.5 rounded-md bg-red-bg px-2.5 py-2 text-xs text-red" data-testid={`deploy-blocked-${card.name}`}>
          {reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      )}
    </article>
  );
}
