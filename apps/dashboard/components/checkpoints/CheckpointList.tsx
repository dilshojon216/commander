import type { CheckpointRow } from "@/lib/checkpoints-view";

interface Props {
  rows: CheckpointRow[];
  onDiff: (row: CheckpointRow) => void;
  onRestore: (row: CheckpointRow) => void;
  /** Qaytarish tugmasini o'chirish (lockdown, token yo'q, boshqa qaytarish): sabab. */
  restoreBlock: string | null;
  activeDiffRef: string | null;
}

/** Checkpointlar jadvali (hook'siz: testlanadi): yorliq, vaqt, branch, HEAD, avto, kuzatilmagan fayllar. */
export function CheckpointList({ rows, onDiff, onRestore, restoreBlock, activeDiffRef }: Props) {
  if (rows.length === 0) return <p className="m-0 text-xs text-mu">Hali checkpoint yo&apos;q.</p>;
  return (
    <div className="overflow-x-auto" data-testid="checkpoint-list">
      <table className="w-full border-collapse text-xs">
        <thead>
          <tr className="text-left text-mu">
            <th className="py-1 pr-2 font-medium">Yorliq</th>
            <th className="py-1 pr-2 font-medium">Vaqt</th>
            <th className="py-1 pr-2 font-medium">Branch</th>
            <th className="py-1 pr-2 font-medium">HEAD</th>
            <th className="py-1 pr-2 font-medium">Kuzatilmagan</th>
            <th className="py-1 font-medium">
              <span className="sr-only">Amallar</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.ref} className="border-t border-bd" data-testid="checkpoint-row">
              <td className="py-1.5 pr-2">
                <span className="mono">{r.label}</span>
                {r.auto && (
                  <span className="pill ml-2 bg-blue-bg text-blue" data-testid="auto-badge">
                    avto
                  </span>
                )}
              </td>
              <td className="py-1.5 pr-2" suppressHydrationWarning>
                {r.time}
              </td>
              <td className="mono py-1.5 pr-2">{r.branch ?? "—"}</td>
              <td className="mono py-1.5 pr-2" title={r.sha}>
                {r.head8}
              </td>
              <td className="py-1.5 pr-2" title={r.untrackedText}>
                {r.untracked}
              </td>
              <td className="whitespace-nowrap py-1.5 text-right">
                <button type="button" className="btn" aria-pressed={activeDiffRef === r.ref} onClick={() => onDiff(r)} data-testid="checkpoint-diff-btn">
                  Diffni ko&apos;rish
                </button>
                <button type="button" className="btn ml-1.5" disabled={!!restoreBlock} title={restoreBlock ?? `«${r.label}» holatiga qaytarish`} onClick={() => onRestore(r)} data-testid="checkpoint-restore-btn">
                  Qaytarish
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
