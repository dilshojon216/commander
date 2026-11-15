"use client";

import type { SessionDto } from "@commander/contracts";
import Link from "next/link";
import { OPEN_LABEL, useOpenSession } from "@/components/control/OpenSessionButton";
import { ResumeButton } from "@/components/control/ResumeButton";
import { SessionQuickActions } from "@/components/control/SessionQuickActions";
import { TaskPill } from "@/components/TaskPill";
import { IconPlus } from "@/components/ui/icons";
import { StatusPill } from "@/components/ui/StatusPill";
import { shortMachineName } from "@/lib/machines";
import { MODE_OPTIONS, readPermissionMode } from "@/lib/permission-mode";
import { SET_MODE_HINT } from "@/lib/control-ui";
import { displayStatus } from "@/lib/status";

/** "Sessiyalar va rejim": loyihaning faol sessiyalari, rejim (faqat ko'rsatish), tezkor prompt/to'xtatish, "+ sessiya". */
export function SessionsPanel({ sessions, resumable = [], machineId, cwd }: { sessions: SessionDto[]; resumable?: SessionDto[]; machineId: string; cwd: string }) {
  const open = useOpenSession(machineId);
  return (
    <section className="card overflow-hidden" aria-label="Sessiyalar va rejim">
      <div className="flex flex-wrap items-center gap-3 px-4 py-2.5">
        <span className="lbl">Sessiyalar va rejim</span>
        <span className="flex-1" />
        <span className="max-w-[320px] text-xs text-mu">Qo&apos;lda: har amalda ruxsat so&apos;raydi. Avto: tahrirlar o&apos;zi qilinadi. Reja: faqat reja tuzadi.</span>
        <button type="button" className="btn btn-pri h-7 text-xs" disabled={!!open.reason} title={open.reason ?? OPEN_LABEL} onClick={() => open.open(cwd)}>
          <IconPlus size={12} />
          sessiya
        </button>
      </div>
      {sessions.length === 0 && <p className="m-0 border-t border-bd px-4 py-3 text-mu">Hozir bu loyihada faol sessiya yo&apos;q.</p>}
      {sessions.map((s) => {
        const mode = readPermissionMode(s);
        return (
          <div key={s.id} className="border-t border-bd" data-testid="work-session">
            <div className="flex flex-wrap items-center gap-2.5 px-4 py-2">
              <StatusPill status={displayStatus(s)} />
              <TaskPill session={s} />
              <Link href={`/sessions/${s.id}`} className="mono text-xs font-semibold text-tx">
                {shortMachineName(s.machineName)}
              </Link>
              <span className="mono text-[11px] text-mu">{s.model ?? "model noma'lum"}</span>
              <span className="flex-1" />
              <div role="group" aria-label="Sessiya rejimi" className="inline-flex gap-0.5 rounded-[7px] bg-s3 p-0.5" title={SET_MODE_HINT}>
                {MODE_OPTIONS.map((m) => (
                  <button key={m.id} type="button" disabled aria-pressed={mode === m.id} title={`${m.hint}. ${SET_MODE_HINT}`} className={`h-6 rounded-[5px] border-0 px-[9px] text-[11px] font-semibold disabled:cursor-not-allowed ${mode === m.id ? "bg-s1 text-tx" : "bg-transparent text-mu"}`}>
                    {m.label}
                  </button>
                ))}
              </div>
            </div>
            <SessionQuickActions session={s} />
          </div>
        );
      })}
      {resumable.length > 0 && (
        <div className="border-t border-bd" data-testid="work-resumable">
          <div className="px-4 py-2">
            <span className="lbl">Tugagan terminal sessiyalar</span>
          </div>
          {resumable.map((s) => (
            <div key={s.id} className="flex flex-wrap items-center gap-2.5 border-t border-bd px-4 py-2">
              <StatusPill status={displayStatus(s)} />
              <Link href={`/sessions/${s.id}`} className="mono text-xs font-semibold text-tx">
                {shortMachineName(s.machineName)}
              </Link>
              <span className="mono text-[11px] text-mu">{s.model ?? "model noma'lum"}</span>
              <span className="flex-1" />
              <ResumeButton session={s} />
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
