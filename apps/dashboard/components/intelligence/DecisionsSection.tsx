"use client";

import { ListDecisionsResponseSchema } from "@commander/contracts";
import type { DecisionDto, PatchDecisionBody } from "@commander/contracts";
import { DECISION_LIMITS, DecisionDtoSchema } from "@commander/contracts";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useLiveData } from "@/components/LiveData";
import { ApiCallError, getJson, patchJson, postJson } from "@/lib/client-api";
import {
  ACCEPT_PATCH,
  ARCHIVE_PATCH,
  EMPTY_DECISION_FORM,
  SOURCE_LABEL,
  buildPatch,
  formFromDecision,
  groupDecisions,
  upsertDecision,
  validateDecisionForm,
} from "@/lib/decisions-view";
import type { DecisionErrors, DecisionForm } from "@/lib/decisions-view";
import { formatDateTime } from "@/lib/format";
import { writeErrorText } from "@/lib/intel-errors";

interface FormProps {
  initial: DecisionForm;
  submitLabel: string;
  busy: boolean;
  disabled: boolean;
  error: string | null;
  validate: (f: DecisionForm) => DecisionErrors;
  onSubmit: (f: DecisionForm) => void;
  onCancel?: () => void;
}

function DecisionFormFields({ initial, submitLabel, busy, disabled, error, validate, onSubmit, onCancel }: FormProps) {
  const [f, setF] = useState(initial);
  const [errors, setErrors] = useState<DecisionErrors>({});
  const set = (patch: Partial<DecisionForm>) => setF((x) => ({ ...x, ...patch }));
  const off = disabled || busy;
  return (
    <form
      className="flex flex-col gap-2.5"
      data-testid="decision-form"
      onSubmit={(e) => {
        e.preventDefault();
        const errs = validate(f);
        setErrors(errs);
        if (Object.keys(errs).length === 0) onSubmit(f);
      }}
    >
      <label className="flex flex-col gap-1 text-xs text-mu">
        Sarlavha
        <input className="field" value={f.title} onChange={(e) => set({ title: e.target.value })} disabled={off} maxLength={DECISION_LIMITS.titleMaxChars + 20} aria-invalid={errors.title ? true : undefined} data-testid="dec-title" />
        {errors.title && <span className="text-[11px] text-red">{errors.title}</span>}
      </label>
      <label className="flex flex-col gap-1 text-xs text-mu">
        Qaror
        <textarea className="field" rows={3} value={f.decision} onChange={(e) => set({ decision: e.target.value })} disabled={off} aria-invalid={errors.decision ? true : undefined} data-testid="dec-decision" />
        {errors.decision && <span className="text-[11px] text-red">{errors.decision}</span>}
      </label>
      <label className="flex flex-col gap-1 text-xs text-mu">
        Sabab
        <textarea className="field" rows={2} value={f.reason} onChange={(e) => set({ reason: e.target.value })} disabled={off} aria-invalid={errors.reason ? true : undefined} data-testid="dec-reason" />
        {errors.reason && <span className="text-[11px] text-red">{errors.reason}</span>}
      </label>
      <label className="flex flex-col gap-1 text-xs text-mu">
        Muqobillar (har qatorda bittadan, ixtiyoriy)
        <textarea className="field" rows={3} value={f.alternatives} onChange={(e) => set({ alternatives: e.target.value })} disabled={off} aria-invalid={errors.alternatives ? true : undefined} data-testid="dec-alternatives" />
        {errors.alternatives && <span className="text-[11px] text-red">{errors.alternatives}</span>}
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" className="btn btn-ok" disabled={off} data-testid="dec-submit">
          {busy ? "Saqlanmoqda..." : submitLabel}
        </button>
        {onCancel && (
          <button type="button" className="btn" onClick={onCancel} disabled={busy}>
            Bekor
          </button>
        )}
        {error && (
          <span role="alert" className="text-xs text-red" data-testid="dec-error">
            {error}
          </span>
        )}
      </div>
    </form>
  );
}

function DecisionBody({ d }: { d: DecisionDto }) {
  return (
    <div className="flex flex-col gap-1.5">
      <p className="m-0 whitespace-pre-wrap">{d.decision}</p>
      <p className="m-0 whitespace-pre-wrap text-xs text-mu">
        <b className="text-tx">Sabab:</b> {d.reason}
      </p>
      {d.alternatives.length > 0 && (
        <div className="text-xs text-mu">
          <b className="text-tx">Muqobillar:</b>
          <ul className="m-0 mt-0.5 list-disc pl-5">
            {d.alternatives.map((a, i) => (
              <li key={`${i}:${a}`}>{a}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** "Qarorlar" yorlig'i: faol qarorlar, takliflar (qabul/rad), yaratish, tahrirlash, arxiv. Yozuvlar elevation bilan (`apiFetch` qayta tasdiqlashni so'raydi). */
export function DecisionsSection({ projectId }: { projectId: string }) {
  const { canControl } = useLiveData();
  const [items, setItems] = useState<DecisionDto[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    (signal?: AbortSignal) => {
      getJson(`/projects/${projectId}/decisions`, ListDecisionsResponseSchema, signal)
        .then((r) => {
          setItems(r.items);
          setLoadError(null);
        })
        .catch((e: unknown) => {
          if (!signal?.aborted) setLoadError(e instanceof Error ? e.message : "Qarorlarni olib bo'lmadi");
        });
    },
    [projectId],
  );

  useEffect(() => {
    const ctl = new AbortController();
    load(ctl.signal);
    return () => ctl.abort();
  }, [load]);

  const groups = useMemo(() => groupDecisions(items ?? []), [items]);
  const disabled = !canControl;

  async function run(id: string, fn: () => Promise<DecisionDto>): Promise<boolean> {
    setBusyId(id);
    setError(null);
    try {
      const d = await fn();
      setItems((l) => upsertDecision(l ?? [], d));
      return true;
    } catch (e) {
      setError(writeErrorText(e instanceof ApiCallError ? e.status : 0));
      return false;
    } finally {
      setBusyId(null);
    }
  }

  const patch = (d: DecisionDto, body: PatchDecisionBody) => run(d.id, () => patchJson(`/decisions/${d.id}`, body, DecisionDtoSchema));

  const row = (d: DecisionDto, kind: "proposed" | "active" | "archived") => {
    const busy = busyId === d.id;
    if (editingId === d.id) {
      return (
        <li key={d.id} className="border-t border-bd px-4 py-3">
          <DecisionFormFields
            initial={formFromDecision(d)}
            submitLabel="Saqlash"
            busy={busy}
            disabled={disabled}
            error={error}
            validate={(f) => buildPatch(d, f).errors}
            onCancel={() => setEditingId(null)}
            onSubmit={(f) => {
              const p = buildPatch(d, f);
              if (p.unchanged || !p.value) {
                setEditingId(null);
                return;
              }
              void patch(d, p.value).then((ok) => ok && setEditingId(null));
            }}
          />
        </li>
      );
    }
    return (
      <li key={d.id} className="flex flex-col gap-2 border-t border-bd px-4 py-3" data-testid={`decision-${kind}`}>
        <div className="flex flex-wrap items-baseline gap-2">
          <b className="min-w-0 flex-1 basis-[200px]">{d.title}</b>
          <span className="pill bg-s3 text-mu">{SOURCE_LABEL[d.source]}</span>
          <span className="mono text-[11px] text-fa" suppressHydrationWarning>
            {formatDateTime(d.createdAt)}
          </span>
        </div>
        <DecisionBody d={d} />
        <div className="flex flex-wrap items-center gap-2">
          {d.sourceSessionId && (
            <Link href={`/sessions/${d.sourceSessionId}`} className="text-xs">
              Manba sessiya →
            </Link>
          )}
          <span className="flex-1" />
          {kind === "proposed" && (
            <>
              <button type="button" className="btn btn-ok" disabled={disabled || busy} onClick={() => void patch(d, ACCEPT_PATCH)} data-testid="dec-accept">
                Qabul qilish
              </button>
              <button type="button" className="btn btn-no" disabled={disabled || busy} onClick={() => void patch(d, ARCHIVE_PATCH)} data-testid="dec-reject">
                Rad etish
              </button>
            </>
          )}
          {kind === "active" && (
            <>
              <button type="button" className="btn" disabled={disabled || busy} onClick={() => setEditingId(d.id)} data-testid="dec-edit">
                Tahrirlash
              </button>
              <button type="button" className="btn" disabled={disabled || busy} onClick={() => void patch(d, ARCHIVE_PATCH)} data-testid="dec-archive">
                Arxivlash
              </button>
            </>
          )}
          {kind === "archived" && (
            <button type="button" className="btn" disabled={disabled || busy} onClick={() => void patch(d, ACCEPT_PATCH)}>
              Qayta faollashtirish
            </button>
          )}
        </div>
      </li>
    );
  };

  return (
    <div className="flex flex-col gap-5 px-4 py-5 md:px-6" data-testid="decisions-section">
      {loadError && (
        <div role="alert" className="rounded-md bg-red-bg px-3 py-2 text-red">
          {loadError}
        </div>
      )}
      {!loadError && items === null && <div className="sk h-24" aria-busy="true" />}
      {error && editingId === null && (
        <div role="alert" className="rounded-md bg-red-bg px-3 py-2 text-red" data-testid="dec-error-bar">
          {error}
        </div>
      )}

      {items !== null && groups.proposed.length > 0 && (
        <section className="card overflow-hidden" aria-label="Takliflar">
          <h2 className="m-0 px-4 py-3.5 text-sm font-semibold">
            Takliflar <span className="text-xs font-normal text-mu">· sessiya xulosalaridan, tasdiqlash kutilmoqda</span>
          </h2>
          <ul className="m-0 list-none p-0">{groups.proposed.map((d) => row(d, "proposed"))}</ul>
        </section>
      )}

      {items !== null && (
        <section className="card overflow-hidden" aria-label="Qarorlar">
          <div className="flex items-center justify-between gap-2 px-4 py-3.5">
            <h2 className="m-0 text-sm font-semibold">Qarorlar</h2>
            <button type="button" className="btn" disabled={disabled} onClick={() => setCreating((c) => !c)} aria-expanded={creating} data-testid="dec-new">
              {creating ? "Yopish" : "Yangi qaror"}
            </button>
          </div>
          {creating && (
            <div className="border-t border-bd px-4 py-3">
              <DecisionFormFields
                initial={EMPTY_DECISION_FORM}
                submitLabel="Qo'shish"
                busy={busyId === "new"}
                disabled={disabled}
                error={error}
                validate={(f) => validateDecisionForm(f).errors}
                onCancel={() => setCreating(false)}
                onSubmit={(f) => {
                  const v = validateDecisionForm(f);
                  if (!v.value) return;
                  const body = v.value;
                  void run("new", () => postJson(`/projects/${projectId}/decisions`, body, DecisionDtoSchema)).then((ok) => ok && setCreating(false));
                }}
              />
            </div>
          )}
          {groups.active.length === 0 && !creating && <p className="m-0 border-t border-bd px-4 py-3 text-mu">Faol qaror yo&apos;q. Sessiyalar `commander_record_decision` bilan yozgan yoki siz qo&apos;shgan qarorlar shu yerda.</p>}
          <ul className="m-0 list-none p-0">{groups.active.map((d) => row(d, "active"))}</ul>
          {disabled && <p className="m-0 border-t border-bd px-4 py-2 text-xs text-mu">O&apos;zgartirish uchun boshqaruv token&apos;i kerak (faqat o&apos;qish).</p>}
        </section>
      )}

      {items !== null && groups.archived.length > 0 && (
        <section className="card overflow-hidden" aria-label="Arxiv">
          <button type="button" className="flex w-full cursor-pointer items-center justify-between border-0 bg-transparent px-4 py-3.5 text-left text-tx" style={{ font: "inherit" }} aria-expanded={showArchived} onClick={() => setShowArchived((v) => !v)} data-testid="dec-archived-toggle">
            <h2 className="m-0 text-sm font-semibold">Arxiv ({groups.archived.length})</h2>
            <span className="text-xs text-mu">{showArchived ? "Yashirish" : "Ko'rsatish"}</span>
          </button>
          {showArchived && <ul className="m-0 list-none p-0">{groups.archived.map((d) => row(d, "archived"))}</ul>}
        </section>
      )}
    </div>
  );
}
