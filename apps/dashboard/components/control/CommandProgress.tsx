import type { CommandDto } from "@commander/contracts";
import { commandProgress } from "@/lib/control-ui";

const TYPE_LABEL: Record<string, string> = {
  "session.prompt": "Prompt",
  "session.stop": "To'xtatish",
  "session.start": "Yangi sessiya",
  "session.set_mode": "Rejim",
  "session.remote_control": "Remote Control",
  "session.resume": "Davom ettirish",
  "session.close": "Yopish",
  "deploy.run": "Deploy",
  "deploy.rollback": "Rollback",
  "git.checkpoint_restore": "Checkpoint qaytarish",
};

/** Buyruq jarayoni: Yuborildi -> Qabul qilindi -> Bajarilmoqda -> Tayyor / xato (o'zbekcha). */
export function CommandProgress({ command }: { command: CommandDto }) {
  const p = commandProgress(command);
  return (
    <div role="status" aria-live="polite" data-testid="command-progress" data-phase={p.phase} className={`flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg px-3 py-2 text-xs ${p.phase === "failed" ? "bg-red-bg text-red" : p.phase === "done" ? "bg-grn-bg text-grn" : "bg-blue-bg text-blue"}`}>
      <span className="font-semibold">{TYPE_LABEL[command.type] ?? "Buyruq"}:</span>
      {p.phase === "failed" ? (
        <span>
          {p.label}. {p.error}
        </span>
      ) : p.phase === "confirming" ? (
        <span>{p.label}</span>
      ) : (
        <ol className="m-0 flex list-none flex-wrap items-center gap-x-2 p-0">
          {p.steps.map((s, i) => (
            <li key={s} className={i <= p.active ? "font-semibold" : "opacity-50"}>
              {i < p.active || p.phase === "done" ? "✓ " : i === p.active ? "● " : "○ "}
              {s}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
