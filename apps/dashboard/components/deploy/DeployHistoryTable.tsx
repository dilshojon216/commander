import { OUTPUT_NOT_STORED, TONE_CLASS } from "@/lib/deploy-view";
import type { RunRow, StepRow } from "@/lib/deploy-view";

/** Qadamlar jadvali: bosqich, nom, holat, chiqish kodi, davomiylik (faqat matn). */
export function StepsTable({ rows }: { rows: StepRow[] }) {
  if (rows.length === 0) return <span className="text-xs text-mu">Qadamlar xulosasi yo&apos;q.</span>;
  return (
    <table className="w-full border-collapse text-xs" data-testid="steps-table">
      <thead>
        <tr className="text-left text-mu">
          <th className="py-1 pr-2 font-medium">Bosqich</th>
          <th className="py-1 pr-2 font-medium">Qadam</th>
          <th className="py-1 pr-2 font-medium">Holat</th>
          <th className="py-1 pr-2 font-medium">Kod</th>
          <th className="py-1 font-medium">Davomiyligi</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.key} className="border-t border-bd">
            <td className="py-1 pr-2">{r.phase}</td>
            <td className="mono py-1 pr-2">{r.name}</td>
            <td className="py-1 pr-2">
              <span className={`pill ${TONE_CLASS[r.status.tone]}`}>{r.status.label}</span>
            </td>
            <td className="mono py-1 pr-2">{r.exit}</td>
            <td className="mono py-1">{r.duration}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

interface Props {
  rows: RunRow[];
  expanded: ReadonlySet<string>;
  onToggle: (commandId: string) => void;
  onRollback: (row: RunRow) => void;
  /** Rollback tugmasini umumiy o'chirish (lockdown, token yo'q): sabab. */
  rollbackBlock: string | null;
}

/** Deploy tarixi (hook'siz: testlanadi). Chiqish saqlanmaydi: faqat qadamlar xulosasi. */
export function DeployHistoryTable({ rows, expanded, onToggle, onRollback, rollbackBlock }: Props) {
  return (
    <div className="flex flex-col gap-2" data-testid="deploy-history">
      <span className="text-xs text-mu">{OUTPUT_NOT_STORED}</span>
      {rows.length === 0 ? (
        <p className="m-0 text-xs text-mu">Hali deploy bo&apos;lmagan.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-xs">
            <thead>
              <tr className="text-left text-mu">
                <th className="py-1 pr-2 font-medium">Vaqt</th>
                <th className="py-1 pr-2 font-medium">Tur</th>
                <th className="py-1 pr-2 font-medium">Maqsad</th>
                <th className="py-1 pr-2 font-medium">Commit</th>
                <th className="py-1 pr-2 font-medium">Xesh</th>
                <th className="py-1 pr-2 font-medium">Holat</th>
                <th className="py-1 pr-2 font-medium">Natija</th>
                <th className="py-1 pr-2 font-medium">Davomiyligi</th>
                <th className="py-1 pr-2 font-medium">Xato qadami</th>
                <th className="py-1 font-medium">
                  <span className="sr-only">Amallar</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const open = expanded.has(r.commandId);
                return (
                  <HistoryRows key={r.commandId} row={r} open={open} onToggle={onToggle} onRollback={onRollback} rollbackBlock={rollbackBlock} />
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function HistoryRows({ row: r, open, onToggle, onRollback, rollbackBlock }: { row: RunRow; open: boolean; onToggle: (id: string) => void; onRollback: (r: RunRow) => void; rollbackBlock: string | null }) {
  return (
    <>
      <tr className="border-t border-bd" data-testid="deploy-history-row" data-command-id={r.commandId}>
        <td className="py-1.5 pr-2" suppressHydrationWarning>
          {r.time}
        </td>
        <td className="py-1.5 pr-2">{r.kindLabel}</td>
        <td className="mono py-1.5 pr-2">{r.target}</td>
        <td className="mono py-1.5 pr-2">{r.commit8}</td>
        <td className="mono py-1.5 pr-2">{r.hash8}</td>
        <td className="py-1.5 pr-2">
          <span className={`pill ${TONE_CLASS[r.status.tone]}`}>{r.status.label}</span>
        </td>
        <td className="py-1.5 pr-2">{r.outcome ? <span className={`pill ${TONE_CLASS[r.outcome.tone]}`}>{r.outcome.label}</span> : "—"}</td>
        <td className="mono py-1.5 pr-2">{r.duration}</td>
        <td className="py-1.5 pr-2">{r.failedStep ?? "—"}</td>
        <td className="whitespace-nowrap py-1.5 text-right">
          {r.steps.length > 0 && (
            <button type="button" className="btn" aria-expanded={open} onClick={() => onToggle(r.commandId)} data-testid="deploy-history-toggle">
              {open ? "Yopish" : "Qadamlar"}
            </button>
          )}
          {r.canRollback && (
            <button type="button" className="btn ml-1.5" disabled={!!rollbackBlock} title={rollbackBlock ?? `${r.target}: rollback`} onClick={() => onRollback(r)} data-testid="rollback-btn">
              Rollback
            </button>
          )}
        </td>
      </tr>
      {open && r.steps.length > 0 && (
        <tr data-testid="deploy-history-steps">
          <td colSpan={10} className="pb-2 pl-3">
            <StepsTable rows={r.steps} />
          </td>
        </tr>
      )}
    </>
  );
}
