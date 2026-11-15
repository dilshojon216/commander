"use client";

import { useLiveData } from "@/components/LiveData";
import { HelpLink } from "@/components/help/RemoteControlHint";
import { useShellUi } from "@/components/shell/ShellUi";
import { IconPlus } from "@/components/ui/icons";
import { startBlockReason } from "@/lib/control-ui";
import { isPolicyOffReason } from "@/lib/remote-control-hint";

/** Loyihadan sessiya ochish: mashina va papka oldindan to'ldirilgan "Yangi sessiya" oynasini ochadi. */
export function useOpenSession(machineId: string): { reason: string | null; open: (cwd: string) => void } {
  const { machines, lockdown, canControl } = useLiveData();
  const { openNewSession } = useShellUi();
  const machine = machines.find((m) => m.id === machineId);
  const reason = lockdown ? "Lockdown yoqiq: masofaviy boshqaruv o'chirilgan" : !canControl ? "COMMANDER_CONTROL_TOKEN sozlanmagan: dashboard boshqaruvi o'chiq" : startBlockReason(machine);
  return { reason, open: (cwd) => openNewSession({ machineId, cwd }) };
}

export const OPEN_LABEL = "Shu loyihada sessiya ochish";

/** Sarlavhadagi asosiy tugma: o'chiq bo'lsa ham ko'rinadi, sabab tooltip va qatorda. */
export function OpenSessionButton({ machineId, cwd }: { machineId: string; cwd: string }) {
  const { reason, open } = useOpenSession(machineId);
  return (
    <div className="flex flex-col items-end gap-1">
      <button type="button" className="btn btn-pri" disabled={!!reason} title={reason ?? OPEN_LABEL} aria-describedby={reason ? "open-reason" : undefined} onClick={() => open(cwd)}>
        <IconPlus size={14} />
        {OPEN_LABEL}
      </button>
      {reason && (
        <span id="open-reason" className="max-w-[360px] text-right text-[11px] text-org" data-testid="open-reason">
          {reason} {isPolicyOffReason(reason) && <HelpLink />}
        </span>
      )}
    </div>
  );
}

/** Jadval qatoridagi kichik ikonka tugma. */
export function OpenSessionIconButton({ machineId, cwd, name }: { machineId: string; cwd: string; name: string }) {
  const { reason, open } = useOpenSession(machineId);
  return (
    <button type="button" className="btn h-7 w-7 p-0" disabled={!!reason} title={reason ?? `${name}: sessiya ochish`} aria-label={`${name}: sessiya ochish`} onClick={() => open(cwd)}>
      <IconPlus size={14} />
    </button>
  );
}
