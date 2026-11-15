"use client";

import { useEffect } from "react";
import { useTrackedCommand } from "@/components/control/useControl";
import { configErrorText } from "@/lib/config-ui";
import { commandProgress } from "@/lib/control-ui";

/** Apply/rollback buyrug'i jarayoni (Telegram tasdig'i ham shu yerda ko'rinadi). Tugaganda `onSettled` bir marta chaqiriladi. */
export function ConfigCommandStatus({ commandId, label, onSettled }: { commandId: string; label: string; onSettled: () => void }) {
  const cmd = useTrackedCommand(commandId);
  const p = cmd ? commandProgress(cmd) : null;
  const terminal = p?.phase === "done" || p?.phase === "failed";
  useEffect(() => {
    if (terminal) onSettled();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- faqat tugaganda
  }, [terminal]);
  if (!cmd || !p) return <div role="status" className="rounded-lg bg-blue-bg px-3 py-2 text-xs text-blue">{label}: yuborilmoqda…</div>;
  const tone = p.phase === "failed" ? "bg-red-bg text-red" : p.phase === "done" ? "bg-grn-bg text-grn" : "bg-blue-bg text-blue";
  return (
    <div role="status" aria-live="polite" data-testid="config-command" data-phase={p.phase} className={`rounded-lg px-3 py-2 text-xs ${tone}`}>
      <b>{label}:</b>{" "}
      {p.phase === "failed" ? `${p.label}. ${configErrorText(cmd.errorCode)}` : p.phase === "confirming" ? `${p.label} (bot orqali tasdiqlang, 2 daqiqa)` : p.label}
    </div>
  );
}
