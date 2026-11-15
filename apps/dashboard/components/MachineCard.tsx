import type { MachineDto } from "@commander/contracts";
import { machineLabel, osKind, shortMachineName } from "@/lib/machines";
import { machineSubtitle } from "@/lib/machines-view";

/** Ixcham mashina kartasi (Umumiy sahifasi): nom, OS, onlayn nuqta, sessiyalar xulosasi. */
export function MachineCard({ machine: m, now }: { machine: MachineDto; now: number }) {
  const sub = machineSubtitle(m, now);
  return (
    <div className={`card flex flex-col gap-2 p-3 ${m.online ? "" : "border-dashed opacity-60"}`} data-testid="machine-card" data-online={m.online}>
      <div className="flex items-center gap-2">
        <span className={`dot ${m.online ? "text-grn" : "text-fa"}`} role="img" aria-label={m.online ? "onlayn" : "oflayn"} />
        <span className="mono min-w-0 flex-1 break-words font-semibold leading-tight [overflow-wrap:anywhere]" title={machineLabel(m)} data-testid="machine-name">
          {shortMachineName(machineLabel(m))}
        </span>
        <span className="pill mono bg-s3 text-mu" style={{ height: 18, fontSize: 10 }}>
          {osKind(m.os)}
        </span>
      </div>
      <span className={`text-xs ${sub.warn ? "text-org" : "text-mu"}`} suppressHydrationWarning>
        {sub.text}
      </span>
    </div>
  );
}
