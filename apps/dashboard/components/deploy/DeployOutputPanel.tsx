"use client";

import { useEffect, useRef } from "react";
import { useDeployOutput } from "@/lib/use-deploy-output";
import { streamStateLabel, streamStateTone } from "@/lib/logs-view";
import type { LogLine, LogViewState } from "@/lib/logs-view";

interface ViewProps {
  lines: LogLine[];
  state: LogViewState["state"];
  reason: LogViewState["reason"];
  dropped: number;
  clientTrimmed: number;
  truncated: boolean;
  /** Oqim xatosi (agent yoki o'qish). */
  error: string | null;
}

/**
 * Jonli chiqish ko'rinishi: qatorlar FAQAT React matn tugunlari (ANSI markazda olib tashlangan), pastga avto-aylanish
 * (foydalanuvchi tepaga aylantirsa to'xtaydi), tashlangan/kesilgan qatorlar haqida eslatma.
 */
export function DeployOutputView({ lines, state, reason, dropped, clientTrimmed, truncated, error }: ViewProps) {
  const ref = useRef<HTMLPreElement | null>(null);
  const follow = useRef(true);
  const last = lines.length > 0 ? (lines[lines.length - 1] as LogLine).id : -1;
  useEffect(() => {
    const el = ref.current;
    if (follow.current && el) el.scrollTop = el.scrollHeight;
  }, [last]);
  return (
    <div className="flex flex-col gap-1.5" data-testid="deploy-output">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="lbl">Jonli chiqish</span>
        <span className={`pill ${streamStateTone(state)}`} data-testid="deploy-output-state">
          {streamStateLabel(state, reason)}
        </span>
        <span className="text-mu">Chiqish saqlanmaydi: faqat shu yerda jonli ko&apos;rinadi</span>
      </div>
      <pre
        ref={ref}
        tabIndex={0}
        aria-label="Deploy chiqishi"
        onScroll={(e) => {
          const el = e.currentTarget;
          follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
        className="mono m-0 h-[320px] overflow-auto whitespace-pre-wrap break-all rounded-lg border border-bd bg-s1 px-2 py-1.5 text-[11.5px] leading-[1.5]"
        data-testid="deploy-output-lines"
      >
        {lines.length === 0 ? <span className="text-mu">{state === "done" ? "Chiqish bo'sh." : "Chiqish kutilmoqda…"}</span> : lines.map((l) => <div key={l.id}>{l.text === "" ? " " : l.text}</div>)}
      </pre>
      {(dropped > 0 || clientTrimmed > 0 || truncated) && (
        <div role="note" className="rounded-md bg-yel-bg px-2.5 py-1.5 text-xs text-yel" data-testid="deploy-output-notes">
          {dropped > 0 && <div>{dropped} qator tashlab yuborildi (bufer to&apos;ldi).</div>}
          {clientTrimmed > 0 && <div>{clientTrimmed} ta eski qator brauzer chegarasi tufayli olib tashlandi.</div>}
          {truncated && <div>Chiqish hajm chegarasida qisqartirildi (deploy davom etadi).</div>}
        </div>
      )}
      {error && (
        <div role="alert" className="rounded-md bg-red-bg px-2.5 py-1.5 text-xs text-red" data-testid="deploy-output-error">
          {error}
        </div>
      )}
    </div>
  );
}

/** Bog'langan versiya: `key={commandId}` bilan chaqiring (holat yangidan boshlanadi). */
export function DeployOutputPanel({ commandId, finished }: { commandId: string; finished: boolean }) {
  const o = useDeployOutput(commandId, true, finished);
  const err = o.error ?? o.view.error?.message ?? null;
  return <DeployOutputView lines={o.view.lines} state={o.view.state} reason={o.view.reason} dropped={o.view.dropped} clientTrimmed={o.view.clientTrimmed} truncated={o.view.truncated} error={err} />;
}
