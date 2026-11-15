"use client";

import type { OrchStepDto, OrchestrationDto, ProjectDto, SessionDto } from "@commander/contracts";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useLiveData } from "@/components/LiveData";
import { formatClock } from "@/lib/format";
import { EMPTY_CREATE_FORM, ORCH_STATUS_UZ, STEP_STATUS_UZ, budgetView, buildCreateBody, buildTimeline, createReason, isActiveOrch, layoutSteps, leadCandidates, progressText, stepErrorText, stopReason } from "@/lib/orchestration-view";
import type { CreateForm, Tone } from "@/lib/orchestration-view";
import { useOrchestrations } from "./useOrchestrations";

const TONE: Record<Tone, string> = {
  blue: "bg-blue-bg text-blue",
  yel: "bg-yel-bg text-yel",
  grn: "bg-grn-bg text-grn",
  red: "bg-red-bg text-red",
  gray: "bg-gray-bg text-mu",
};
const BAR: Record<Tone, string> = { blue: "var(--blue)", yel: "var(--yel)", grn: "var(--grn)", red: "var(--red)", gray: "var(--mu)" };

export interface OrchPrefill {
  goal: string;
  taskKey: string | null;
}

/** Loyiha ish maydonidagi "Orkestratsiya" yorlig'i: yaratish, daraxt/graf, byudjet, "To'xtatish", vaqt chizig'i. */
export function OrchestrationPanel({ project, sessions, prefill, onPrefillUsed }: { project: ProjectDto; sessions: SessionDto[]; prefill: OrchPrefill | null; onPrefillUsed: () => void }) {
  const api = useOrchestrations(project.id);
  const { lockdown, canControl } = useLiveData();
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<CreateForm>(EMPTY_CREATE_FORM);
  const [taskKey, setTaskKey] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const blocked = createReason({ lockdown, canControl });

  // Vazifa kartasidan kelgan maqsad: renderda holatni moslaymiz (effektda setState emas), keyin ota holatni tozalaymiz
  const [seen, setSeen] = useState<OrchPrefill | null>(null);
  if (prefill && prefill !== seen) {
    setSeen(prefill);
    setForm({ ...EMPTY_CREATE_FORM, goal: prefill.goal });
    setTaskKey(prefill.taskKey);
    setCreating(true);
  }
  useEffect(() => {
    if (prefill) onPrefillUsed();
  }, [prefill, onPrefillUsed]);

  const busyLeads = useMemo(() => new Set(api.items.filter(isActiveOrch).map((o) => o.leadSessionId).filter((x): x is string => x !== null)), [api.items]);
  const leads = useMemo(() => leadCandidates(sessions, project.id, busyLeads), [sessions, project.id, busyLeads]);

  async function submit() {
    setFormError(null);
    const r = buildCreateBody(form, { projectId: project.id, machineId: project.machineId, cwd: project.path, taskKey });
    if (!r.ok) return setFormError(r.error);
    setBusy(true);
    const res = await api.create(r.body);
    setBusy(false);
    if (!res.ok) return setFormError(res.error);
    setCreating(false);
    setForm(EMPTY_CREATE_FORM);
    setTaskKey(null);
  }

  return (
    <div className="flex flex-col gap-3" data-testid="orch-panel">
      <div className="flex flex-wrap items-center gap-3">
        <p className="m-0 flex-1 text-xs text-mu">Bosh sessiya maqsadni qadamlarga bo&apos;ladi va rollar bo&apos;yicha ishchi sessiyalarga tarqatadi. Hamma amal boshqaruv konveyeri va audit orqali o&apos;tadi.</p>
        <button type="button" className="btn btn-pri" disabled={!!blocked} title={blocked ?? undefined} onClick={() => setCreating((v) => !v)} data-testid="orch-new">
          Yangi orkestratsiya
        </button>
      </div>
      {api.error && (
        <div role="alert" className="rounded-md bg-red-bg px-3 py-2 text-xs text-red">
          {api.error}
        </div>
      )}
      {actionError && (
        <div role="alert" className="rounded-md bg-yel-bg px-3 py-2 text-xs text-yel" data-testid="orch-action-error">
          {actionError}
        </div>
      )}

      {creating && (
        <section className="card flex flex-col gap-3 p-4" aria-label="Yangi orkestratsiya" data-testid="orch-form">
          <label className="flex flex-col gap-1 text-xs">
            <span className="lbl">Maqsad{taskKey ? ` · vazifa ${taskKey}` : ""}</span>
            <textarea
              value={form.goal}
              onChange={(e) => setForm({ ...form, goal: e.target.value })}
              rows={4}
              maxLength={2000}
              className="rounded-md border border-bd bg-s2 p-2 text-sm text-tx"
              placeholder="Masalan: foydalanuvchi profiliga telefon maydoni qo'shish (backend + frontend)"
            />
          </label>
          <fieldset className="flex flex-wrap gap-4 border-0 p-0 text-xs">
            <legend className="lbl mb-1 p-0">Bosh sessiya</legend>
            <label className="flex items-center gap-1.5">
              <input type="radio" name="lead" checked={form.leadKind === "new"} onChange={() => setForm({ ...form, leadKind: "new" })} /> Yangi sessiya ({project.path.split("/").slice(-1)[0]})
            </label>
            <label className="flex items-center gap-1.5">
              <input type="radio" name="lead" checked={form.leadKind === "session"} onChange={() => setForm({ ...form, leadKind: "session" })} disabled={leads.length === 0} /> Mavjud sessiya
            </label>
            {form.leadKind === "session" && (
              <select value={form.sessionId} onChange={(e) => setForm({ ...form, sessionId: e.target.value })} className="rounded-md border border-bd bg-s2 px-2 py-1 text-xs text-tx" data-testid="orch-lead-select">
                <option value="">Tanlang…</option>
                {leads.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.label}
                  </option>
                ))}
              </select>
            )}
          </fieldset>
          <div className="flex flex-wrap gap-4 text-xs">
            <label className="flex items-center gap-1.5">
              Parallel
              <input value={form.maxConcurrent} onChange={(e) => setForm({ ...form, maxConcurrent: e.target.value })} inputMode="numeric" className="w-14 rounded-md border border-bd bg-s2 px-2 py-1 text-tx" />
            </label>
            <label className="flex items-center gap-1.5">
              Token byudjeti
              <input value={form.tokenBudget} onChange={(e) => setForm({ ...form, tokenBudget: e.target.value })} inputMode="numeric" placeholder="2 000 000" className="w-32 rounded-md border border-bd bg-s2 px-2 py-1 text-tx" />
            </label>
          </div>
          {form.leadKind === "new" && <p className="m-0 text-[11px] text-mu">Yangi sessiya ochish `session.start` qoidasi bo&apos;yicha tasdiq talab qiladi (Mac dashboard istisnosi yoki Telegram).</p>}
          {formError && (
            <div role="alert" className="rounded-md bg-red-bg px-3 py-2 text-xs text-red" data-testid="orch-form-error">
              {formError}
            </div>
          )}
          <div className="flex gap-2">
            <button type="button" className="btn btn-pri" disabled={busy} onClick={() => void submit()} data-testid="orch-submit">
              Boshlash
            </button>
            <button type="button" className="btn" onClick={() => setCreating(false)}>
              Bekor qilish
            </button>
          </div>
        </section>
      )}

      {api.loaded && api.items.length === 0 && !creating && <div className="card p-6 text-mu">Hozircha orkestratsiya yo&apos;q.</div>}
      {api.items.map((o) => (
        <OrchestrationCard
          key={o.id}
          o={o}
          stop={stopReason(o, { canControl })}
          onStop={async () => {
            setActionError(null);
            const err = await api.cancel(o.id);
            if (err) setActionError(err);
          }}
        />
      ))}
    </div>
  );
}

export function OrchestrationCard({ o, stop, onStop }: { o: OrchestrationDto; stop: string | null; onStop: () => void | Promise<void> }) {
  const [confirm, setConfirm] = useState(false);
  const [open, setOpen] = useState(isActiveOrch(o));
  const st = ORCH_STATUS_UZ[o.status];
  const b = budgetView(o);
  return (
    <article className="card flex flex-col gap-3 p-4" data-testid="orch-card" data-status={o.status}>
      <header className="flex flex-wrap items-center gap-2">
        <span className={`pill ${TONE[st.tone]}`} data-testid="orch-status">
          {st.label}
        </span>
        <h3 className="m-0 min-w-0 flex-1 truncate text-sm font-semibold" title={o.goal}>
          {o.goal}
        </h3>
        <span className="mono text-xs text-mu">{progressText(o)}</span>
        <button type="button" className="btn" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          {open ? "Yopish" : "Batafsil"}
        </button>
        {isActiveOrch(o) &&
          (confirm ? (
            <>
              <button type="button" className="btn btn-pri" style={{ background: "var(--red)" }} onClick={() => void Promise.resolve(onStop()).finally(() => setConfirm(false))} data-testid="orch-stop-confirm">
                Ha, hammasini to&apos;xtat
              </button>
              <button type="button" className="btn" onClick={() => setConfirm(false)}>
                Yo&apos;q
              </button>
            </>
          ) : (
            <button type="button" className="btn" disabled={!!stop} title={stop ?? "Barcha ishtirokchi sessiyalarni to'xtatadi"} onClick={() => setConfirm(true)} data-testid="orch-stop">
              To&apos;xtatish
            </button>
          ))}
      </header>
      <div className="flex flex-col gap-1" data-testid="orch-budget">
        <div className="flex justify-between text-[11px] text-mu">
          <span>Token byudjeti{o.budgetExceeded ? " · TUGADI: yangi dispatch to'xtatilgan" : ""}</span>
          <span className="mono">{b.text}</span>
        </div>
        <div className="h-1.5 overflow-hidden rounded bg-s3" role="progressbar" aria-valuenow={b.pct} aria-valuemin={0} aria-valuemax={100}>
          <div style={{ width: `${b.pct}%`, height: "100%", background: BAR[b.tone] }} />
        </div>
      </div>
      <div className="flex flex-wrap gap-3 text-[11px] text-mu">
        <span>Bosh sessiya: {o.leadSessionId ? <Link href={`/sessions/${o.leadSessionId}`} className="text-blue">{o.leadLabel ?? o.leadSessionId.slice(0, 8)}</Link> : "kutilmoqda"}</span>
        <span>Parallel: {o.maxConcurrent}</span>
        <span>Tasdiq: {o.confirmation ? "bor" : "yo'q (yangi sessiya uchun Telegram tasdig'i kerak)"}</span>
        {o.taskKey && <span>Vazifa: {o.taskKey}</span>}
        {o.cancelReason && <span>Sabab: {o.cancelReason}</span>}
      </div>
      {open && (
        <>
          {o.steps.length === 0 ? <p className="m-0 text-xs text-mu">Reja hali tuzilmagan: bosh sessiya `commander_plan_create` bilan reja tuzadi.</p> : <StepGraph steps={o.steps} />}
          <Timeline o={o} />
        </>
      )}
    </article>
  );
}

/** Daraxt/graf: ustunlar = bog'liqlik chuqurligi; har qadam holat rangi, tayinlangan sessiya havolasi va bog'liqliklari bilan. */
export function StepGraph({ steps }: { steps: readonly OrchStepDto[] }) {
  const levels = layoutSteps(steps);
  return (
    <div className="flex gap-4 overflow-x-auto pb-1" data-testid="orch-graph">
      {levels.map((col, i) => (
        <div key={i} className="flex min-w-[210px] flex-1 flex-col gap-2" data-testid={`orch-level-${i}`}>
          <span className="lbl">{i === 0 ? "Boshlang'ich" : `Bosqich ${i + 1}`}</span>
          {col.map(({ step: s }) => {
            const t = STEP_STATUS_UZ[s.status];
            const err = s.status === "failed" || s.status === "pending" ? stepErrorText(s.lastError) : null;
            return (
              <div key={s.id} className="flex flex-col gap-1 rounded-lg border border-bd bg-s2 p-2.5 text-xs" data-testid="orch-step" data-step={s.key} data-status={s.status} style={{ borderLeft: `3px solid ${BAR[t.tone]}` }}>
                <div className="flex items-center gap-1.5">
                  <span className="mono font-semibold">{s.key}</span>
                  <span className="pill bg-gray-bg text-mu" style={{ height: 18, padding: "0 6px", fontSize: 11 }}>
                    {s.role}
                  </span>
                  <span className={`pill ml-auto ${TONE[t.tone]}`} style={{ height: 18, padding: "0 6px", fontSize: 11 }}>
                    {t.label}
                  </span>
                </div>
                <span className="text-tx">{s.title}</span>
                {s.dependsOn.length > 0 && <span className="text-[11px] text-mu">← {s.dependsOn.join(", ")}</span>}
                {s.assignedSessionId && (
                  <Link href={`/sessions/${s.assignedSessionId}`} className="text-[11px] text-blue" data-testid="orch-step-session">
                    {s.assignedLabel ?? s.assignedSessionId.slice(0, 8)}
                  </Link>
                )}
                {s.dispatchMode && <span className="text-[11px] text-mu">{s.dispatchMode === "existing_session" ? "mavjud sessiya" : s.dispatchMode === "new_session" ? "yangi sessiya" : "navbat"}</span>}
                {s.resultSummary && <span className="text-[11px] text-mu">{s.resultSummary.slice(0, 160)}</span>}
                {err && <span className="text-[11px] text-red">{err}</span>}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

export function Timeline({ o }: { o: OrchestrationDto }) {
  const items = buildTimeline(o);
  return (
    <ol className="m-0 flex list-none flex-col gap-1 p-0 text-[11px]" data-testid="orch-timeline" aria-label="Vaqt chizig'i">
      {items.map((i, idx) => (
        <li key={idx} className="flex gap-2">
          <span className="mono text-mu">{formatClock(i.at)}</span>
          <span className={TONE[i.tone].split(" ")[1]}>{i.text}</span>
        </li>
      ))}
    </ol>
  );
}
