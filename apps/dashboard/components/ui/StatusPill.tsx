import { STATUS_META } from "@/lib/status";
import type { DisplayStatus } from "@/lib/status";

/** Sessiya holati belgisi (dizayn: rang + matn; "Ishlamoqda" nuqtasi pulslaydi). */
export function StatusPill({ status, className = "" }: { status: DisplayStatus; className?: string }) {
  const m = STATUS_META[status];
  return (
    <span className={`pill ${m.fg} ${m.bg} ${className}`} data-status={status}>
      <span className={`dot ${m.live ? "live" : ""}`} />
      {m.label}
      {m.suffix}
    </span>
  );
}
