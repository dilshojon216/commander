"use client";

import type { SessionDto } from "@commander/contracts";
import Link from "next/link";
import { useState } from "react";
import { useLiveData } from "@/components/LiveData";
import { Dialog } from "@/components/ui/Dialog";
import { IconStop } from "@/components/ui/icons";
import { commandProgress, isInFlight, promptBoxState, stopState } from "@/lib/control-ui";
import { shortMachineName } from "@/lib/machines";
import { SessionExtraActions } from "./SessionExtraActions";
import { useCommandRunner, useTrackedCommand } from "./useControl";

/** Loyiha sahifasidagi sessiya qatori amallari: ochish, tezkor prompt (ixcham), to'xtatish (tasdiq bilan). */
export function SessionQuickActions({ session }: { session: SessionDto }) {
  const { lockdown, canControl } = useLiveData();
  const runner = useCommandRunner();
  const [cmdId, setCmdId] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [confirm, setConfirm] = useState(false);
  const cmd = useTrackedCommand(cmdId);
  const busy = runner.submitting || isInFlight(cmd);
  const machine = shortMachineName(session.machineName);
  const prompt = promptBoxState(session, { lockdown, canControl, machine });
  const stop = stopState(session, { lockdown, canControl });
  const progress = cmd ? commandProgress(cmd) : null;

  async function send() {
    const v = text.trim();
    if (!v || busy) return;
    const c = await runner.submit({ type: "session.prompt", sessionId: session.id, text: v });
    if (c) {
      setCmdId(c.id);
      if (c.status !== "rejected" && c.status !== "failed") setText("");
    }
  }
  async function doStop() {
    setConfirm(false);
    const c = await runner.submit({ type: "session.stop", sessionId: session.id });
    if (c) setCmdId(c.id);
  }

  return (
    <div className="flex flex-col gap-1.5 border-t border-bd bg-s2 px-4 py-2" data-testid="session-actions">
      <div className="flex flex-wrap items-center gap-2">
        <Link href={`/sessions/${session.id}`} className="btn h-7 text-xs">
          Ochish
        </Link>
        {prompt.kind === "active" ? (
          <form
            className="flex min-w-[200px] flex-1 items-center gap-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
          >
            <label className="sr-only" htmlFor={`qp-${session.id}`}>
              Tezkor prompt
            </label>
            <input
              id={`qp-${session.id}`}
              value={text}
              onChange={(e) => setText(e.target.value)}
              disabled={busy}
              maxLength={16000}
              placeholder="Tezkor prompt…"
              className="h-7 min-w-0 flex-1 rounded-[7px] border border-bd bg-s1 px-2.5 text-tx outline-none focus:border-blue disabled:opacity-60"
            />
            <button type="submit" className="btn btn-pri h-7 text-xs" disabled={busy || !text.trim()}>
              {busy ? "…" : "Yuborish"}
            </button>
          </form>
        ) : (
          <span className="min-w-0 flex-1 truncate text-xs text-mu" title={prompt.reason ?? undefined}>
            {prompt.reason}
          </span>
        )}
        {session.controls.stop && (
          <button type="button" className="btn btn-stop h-7 text-xs" disabled={!stop.enabled || busy} title={stop.hint} onClick={() => setConfirm(true)}>
            <IconStop size={10} />
            To&apos;xtatish
          </button>
        )}
      </div>
      <SessionExtraActions session={session} />
      {(progress || runner.error) && (
        <span role="status" className={`text-xs ${progress?.phase === "failed" || (!progress && runner.error) ? "text-red" : "text-mu"}`}>
          {progress ? (progress.phase === "failed" ? `${progress.label}. ${progress.error}` : progress.label) : runner.error}
        </span>
      )}
      {confirm && (
        <Dialog labelledBy={`qs-${session.id}`} onClose={() => setConfirm(false)} maxWidth={440} top={120}>
          <div className="flex flex-col gap-3 px-5 py-5">
            <h2 id={`qs-${session.id}`} className="m-0 text-base font-semibold">
              Sessiyani to&apos;xtatasizmi?
            </h2>
            <p className="m-0 text-mu">
              <b className="text-tx">{session.projectName}</b> ({machine}) da Claude to&apos;xtatiladi. Bu masofaviy amal audit jurnaliga yoziladi.
            </p>
            <div className="flex justify-end gap-2">
              <button type="button" className="btn" onClick={() => setConfirm(false)}>
                Bekor
              </button>
              <button type="button" className="btn btn-no" onClick={() => void doStop()}>
                Ha, to&apos;xtatish
              </button>
            </div>
          </div>
        </Dialog>
      )}
    </div>
  );
}
