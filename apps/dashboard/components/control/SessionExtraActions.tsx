"use client";

import type { RenderTemplateResponse, SessionDto } from "@commander/contracts";
import { useEffect, useState } from "react";
import { useLiveData } from "@/components/LiveData";
import { previewStatus, scopeBadge } from "@/components/templates/template-vm";
import { templateApi, useSendTemplate, useTemplateList } from "@/components/templates/useTemplates";
import { Dialog } from "@/components/ui/Dialog";
import { promptBoxState, isInFlight } from "@/lib/control-ui";
import { shortMachineName } from "@/lib/machines";
import { CLOSE_LABEL, CLOSE_WARNING, closeCommandBody, closeView } from "@/lib/resume-ui";
import { RC_ENABLE_WARNING, rcCommandBody, rcDisabledReason, rcView } from "@/lib/rc-ui";
import { CommandProgress } from "./CommandProgress";
import { useCommandRunner, useTrackedCommand } from "./useControl";

/** Sessiya uchun qo'shimcha amallar: shablondan prompt yuborish (3.4) va Remote Control (3.10). */
export function SessionExtraActions({ session }: { session: SessionDto }) {
  const rc = rcView(session);
  return (
    <div className="flex flex-col gap-1.5" data-testid="session-extra-actions">
      <div className="flex flex-wrap items-center gap-2">
        <TemplateSendButton session={session} />
        {rc.kind === "toggle" && <RcToggle session={session} />}
        <CloseButton session={session} />
      </div>
      <RcStatus session={session} />
    </div>
  );
}

function CloseButton({ session }: { session: SessionDto }) {
  const { lockdown, canControl } = useLiveData();
  const runner = useCommandRunner();
  const [cmdId, setCmdId] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const cmd = useTrackedCommand(cmdId);
  const view = closeView(session, { lockdown, canControl });
  if (!view.show) return null;
  const busy = runner.submitting || isInFlight(cmd);
  async function run() {
    setConfirm(false);
    const c = await runner.submit(closeCommandBody(session.id));
    if (c) setCmdId(c.id);
  }
  return (
    <>
      <button type="button" className="btn btn-stop h-7 text-xs" disabled={!view.enabled || busy} title={view.reason ?? undefined} data-testid="close-button" onClick={() => setConfirm(true)}>
        {busy ? "…" : CLOSE_LABEL}
      </button>
      {(cmd || runner.error) && (
        <div className="basis-full">{cmd ? <CommandProgress command={cmd} /> : <span role="alert" className="text-xs text-red">{runner.error}</span>}</div>
      )}
      {confirm && (
        <Dialog labelledBy={`cl-${session.id}`} onClose={() => setConfirm(false)} maxWidth={460} top={120}>
          <div className="flex flex-col gap-3 px-5 py-5">
            <h2 id={`cl-${session.id}`} className="m-0 text-base font-semibold">
              Sessiya yopilsinmi?
            </h2>
            <p className="m-0 text-mu">
              <b className="text-tx">{session.projectName}</b> ({shortMachineName(session.machineName)}): {CLOSE_WARNING}
            </p>
            <div className="flex justify-end gap-2">
              <button type="button" className="btn" onClick={() => setConfirm(false)}>
                Bekor
              </button>
              <button type="button" className="btn btn-pri" data-testid="close-confirm" onClick={() => void run()}>
                Ha, yopish
              </button>
            </div>
          </div>
        </Dialog>
      )}
    </>
  );
}

function RcStatus({ session }: { session: SessionDto }) {
  const rc = rcView(session);
  if (!rc.status && !rc.hint) return null;
  return (
    <span className="text-xs text-mu" data-testid="rc-status">
      {rc.status}
      {rc.url && (
        <>
          {" "}
          <a href={rc.url} target="_blank" rel="noreferrer noopener" className="text-blue">
            Ochish
          </a>
        </>
      )}
      {rc.status && rc.hint ? " · " : ""}
      {rc.hint}
    </span>
  );
}

function RcToggle({ session }: { session: SessionDto }) {
  const { lockdown, canControl } = useLiveData();
  const runner = useCommandRunner();
  const [cmdId, setCmdId] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [name, setName] = useState("");
  const cmd = useTrackedCommand(cmdId);
  const rc = rcView(session);
  const busy = runner.submitting || isInFlight(cmd);
  const reason = rcDisabledReason({ lockdown, canControl });

  async function run(enable: boolean) {
    setConfirm(false);
    const c = await runner.submit(rcCommandBody(session.id, enable, name));
    if (c) setCmdId(c.id);
  }

  return (
    <>
      <button
        type="button"
        className="btn h-7 text-xs"
        disabled={!!reason || busy}
        title={reason ?? undefined}
        data-testid="rc-toggle"
        onClick={() => (rc.enabled ? void run(false) : setConfirm(true))}
      >
        {busy ? "…" : rc.label}
      </button>
      {(cmd || runner.error) && (
        <div className="basis-full">
          {cmd ? (
            <CommandProgress command={cmd} />
          ) : (
            <span role="alert" className="text-xs text-red">
              {runner.error}
            </span>
          )}
        </div>
      )}
      {confirm && (
        <Dialog labelledBy={`rc-${session.id}`} onClose={() => setConfirm(false)} maxWidth={460} top={120}>
          <div className="flex flex-col gap-3 px-5 py-5">
            <h2 id={`rc-${session.id}`} className="m-0 text-base font-semibold">
              Remote Control yoqilsinmi?
            </h2>
            <p className="m-0 text-mu">
              <b className="text-tx">{session.projectName}</b> ({shortMachineName(session.machineName)}): {RC_ENABLE_WARNING}
            </p>
            <label className="flex flex-col gap-1.5">
              <span className="lbl">Nom (ixtiyoriy)</span>
              <input className="field" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} placeholder="Bo'sh: avtomatik cmdr-… nomi" spellCheck={false} />
              <span className="text-xs text-mu">claude.ai/code ro&apos;yxatida shu nom bilan topasiz.</span>
            </label>
            <div className="flex justify-end gap-2">
              <button type="button" className="btn" onClick={() => setConfirm(false)}>
                Bekor
              </button>
              <button type="button" className="btn btn-pri" onClick={() => void run(true)}>
                Ha, yoqish
              </button>
            </div>
          </div>
        </Dialog>
      )}
    </>
  );
}

function TemplateSendButton({ session }: { session: SessionDto }) {
  const { lockdown, canControl } = useLiveData();
  const machine = shortMachineName(session.machineName);
  const prompt = promptBoxState(session, { lockdown, canControl, machine });
  const [open, setOpen] = useState(false);
  const [cmdId, setCmdId] = useState<string | null>(null);
  const cmd = useTrackedCommand(cmdId);
  if (prompt.kind !== "active") return null;
  return (
    <>
      <button type="button" className="btn h-7 text-xs" data-testid="template-send" onClick={() => setOpen(true)} disabled={isInFlight(cmd)}>
        📋 Shablondan yuborish
      </button>
      {cmd && (
        <div className="basis-full">
          <CommandProgress command={cmd} />
        </div>
      )}
      {open && <TemplateSendDialog session={session} onClose={() => setOpen(false)} onSent={(id) => setCmdId(id)} />}
    </>
  );
}

function TemplateSendDialog({ session, onClose, onSent }: { session: SessionDto; onClose: () => void; onSent: (commandId: string) => void }) {
  const list = useTemplateList({ projectId: session.projectId });
  const sender = useSendTemplate();
  const [id, setId] = useState("");
  const [taskKey, setTaskKey] = useState(session.taskKey ?? "");
  const [res, setRes] = useState<RenderTemplateResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const selected = list.items.find((t) => t.id === id) ?? null;

  useEffect(() => {
    if (!id) return;
    let alive = true;
    void templateApi.render(id, { sessionId: session.id, ...(taskKey.trim() ? { taskKey: taskKey.trim() } : {}) }).then((r) => {
      if (!alive) return;
      if (r.ok) {
        setRes(r.value);
        setError(null);
      } else {
        setRes(null);
        setError(r.error);
      }
    });
    return () => {
      alive = false;
    };
  }, [id, taskKey, session.id]);

  async function send() {
    if (!selected) return;
    setError(null);
    const r = await sender.send(selected.id, session.id, taskKey.trim() || undefined);
    if (!r.ok) {
      setError(r.error);
      return;
    }
    onSent(r.value.id);
    onClose();
  }

  const shown = id ? res : null;
  const st = shown ? previewStatus(shown) : null;
  return (
    <Dialog labelledBy={`ts-${session.id}`} onClose={onClose} maxWidth={620}>
      <div className="flex flex-col gap-3 px-5 py-5">
        <h2 id={`ts-${session.id}`} className="m-0 text-base font-semibold">
          Shablondan prompt yuborish
        </h2>
        <p className="m-0 text-xs text-mu">
          <b className="text-tx">{session.projectName}</b> sessiyasiga shablon markazda to&apos;ldirilib prompt sifatida yuboriladi (audit jurnaliga yoziladi).
        </p>
        <label className="flex flex-col gap-1.5">
          <span className="lbl">Shablon</span>
          <select className="field" value={id} onChange={(e) => setId(e.target.value)} data-testid="send-template-select">
            <option value="">Shablon tanlang…</option>
            {list.items.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} · {scopeBadge(t)}
              </option>
            ))}
          </select>
        </label>
        {selected && (
          <label className="flex flex-col gap-1.5">
            <span className="lbl">Vazifa id (ixtiyoriy, {"{{task_key}}"} uchun)</span>
            <input className="field" value={taskKey} maxLength={64} onChange={(e) => setTaskKey(e.target.value)} placeholder="masalan 3.4" />
          </label>
        )}
        {shown && (
          <>
            <pre className="m-0 max-h-60 overflow-auto whitespace-pre-wrap rounded-lg border border-bd bg-s2 p-3 text-xs" data-testid="send-preview">
              {shown.text}
            </pre>
            {st?.note && (
              <span role="status" className="text-xs text-yel">
                {st.note}
              </span>
            )}
          </>
        )}
        {error && (
          <div role="alert" className="rounded-lg bg-red-bg px-3 py-2 text-xs text-red">
            {error}
          </div>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn" onClick={onClose}>
            Bekor
          </button>
          <button type="button" className="btn btn-pri" disabled={!selected || !shown || !st?.ok || sender.submitting} onClick={() => void send()}>
            {sender.submitting ? "Yuborilmoqda…" : "Yuborish"}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
