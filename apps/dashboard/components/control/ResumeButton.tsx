"use client";

import type { SessionDto } from "@commander/contracts";
import { useState } from "react";
import { useLiveData } from "@/components/LiveData";
import { Dialog } from "@/components/ui/Dialog";
import { isInFlight } from "@/lib/control-ui";
import { shortMachineName } from "@/lib/machines";
import { RESUME_LABEL, RESUME_WARNING, attachCommand, resumeCommandBody, resumeView } from "@/lib/resume-ui";
import { CommandProgress } from "./CommandProgress";
import { useCommandRunner, useTrackedCommand } from "./useControl";

/**
 * "Davom ettirish" (6.14): tugagan terminal sessiyani yangi tmux sessiyada davom ettirish. Faqat markaz `resume.available` desa ko'rinadi.
 * Tasdiq oynasi -> `POST /commands {type:'session.resume'}` (dashboard elevation + Telegram step-up) -> jarayon -> `tmux attach` buyrug'i.
 */
export function ResumeButton({ session }: { session: SessionDto }) {
  const { lockdown, canControl } = useLiveData();
  const runner = useCommandRunner();
  const [cmdId, setCmdId] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const cmd = useTrackedCommand(cmdId);
  const view = resumeView(session, { lockdown, canControl });
  if (!view.show && !cmd) return null;
  const busy = runner.submitting || isInFlight(cmd);
  const attach = cmd ? attachCommand(cmd) : null;

  async function run() {
    setConfirm(false);
    const c = await runner.submit(resumeCommandBody(session.id));
    if (c) setCmdId(c.id);
  }

  return (
    <div className="flex flex-col gap-1.5" data-testid="resume-box">
      {view.show && !attach && (
        <div>
          <button type="button" className="btn btn-pri h-7 text-xs" disabled={!view.enabled || busy} title={view.reason ?? undefined} data-testid="resume-button" onClick={() => setConfirm(true)}>
            {busy ? "…" : RESUME_LABEL}
          </button>
        </div>
      )}
      {(cmd || runner.error) && (
        <div>
          {cmd ? (
            <CommandProgress command={cmd} />
          ) : (
            <span role="alert" className="text-xs text-red">
              {runner.error}
            </span>
          )}
        </div>
      )}
      {attach && (
        <div className="flex flex-col gap-1 rounded-lg border border-bd bg-s2 px-3 py-2 text-xs" data-testid="resume-attach">
          <span className="text-mu">Sessiya tmux ichida davom etmoqda. Terminalda ochish uchun:</span>
          <code className="mono select-all text-tx">{attach}</code>
        </div>
      )}
      {confirm && (
        <Dialog labelledBy={`rs-${session.id}`} onClose={() => setConfirm(false)} maxWidth={480} top={120}>
          <div className="flex flex-col gap-3 px-5 py-5">
            <h2 id={`rs-${session.id}`} className="m-0 text-base font-semibold">
              Sessiya davom ettirilsinmi?
            </h2>
            <p className="m-0 text-mu">
              <b className="text-tx">{session.projectName}</b> ({shortMachineName(session.machineName)}): {RESUME_WARNING}
            </p>
            <div className="flex justify-end gap-2">
              <button type="button" className="btn" onClick={() => setConfirm(false)}>
                Bekor
              </button>
              <button type="button" className="btn btn-pri" data-testid="resume-confirm" onClick={() => void run()}>
                Ha, davom ettirish
              </button>
            </div>
          </div>
        </Dialog>
      )}
    </div>
  );
}
