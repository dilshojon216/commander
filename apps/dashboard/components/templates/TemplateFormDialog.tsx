"use client";

import type { TemplateDto } from "@commander/contracts";
import { useMemo, useRef, useState } from "react";
import { useLiveData } from "@/components/LiveData";
import { Dialog } from "@/components/ui/Dialog";
import { IconClose } from "@/components/ui/icons";
import { MODEL_OPTIONS } from "@/lib/control-ui";
import { EMPTY_FORM, SCOPE_LABEL, SCOPE_ORDER, TEMPLATE_MODES, buildCreateBody, buildUpdateBody, formFromDto, insertVariable, validateForm, variableHelpRows } from "./template-vm";
import type { TemplateForm } from "./template-vm";
import { templateApi } from "./useTemplates";

/** Shablon yaratish / tahrirlash. Tahrirda ko'lam va ega (loyiha/repo) o'zgarmaydi (o'chirib qayta yarating). */
export function TemplateFormDialog({ editing, onClose, onSaved }: { editing: TemplateDto | null; onClose: () => void; onSaved: () => void }) {
  const { projects } = useLiveData();
  const [form, setForm] = useState<TemplateForm>(editing ? formFromDto(editing) : EMPTY_FORM);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const errors = validateForm(form, !!editing);
  const repoKeys = useMemo(() => [...new Set((projects?.items ?? []).map((p) => p.repoKey).filter((k): k is string => !!k))].sort(), [projects]);
  const set = <K extends keyof TemplateForm>(k: K, v: TemplateForm[K]) => setForm((f) => ({ ...f, [k]: v }));
  const rows = variableHelpRows();

  function insert(name: string) {
    const el = area.current;
    const r = insertVariable(form.body, el?.selectionStart ?? form.body.length, el?.selectionEnd ?? form.body.length, name);
    set("body", r.body);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(r.cursor, r.cursor);
    });
  }

  async function save() {
    setTouched(true);
    if (Object.keys(errors).length > 0 || busy) return;
    setBusy(true);
    setError(null);
    let res;
    if (editing) {
      const body = buildUpdateBody(form, editing);
      if (!body) {
        onClose();
        return;
      }
      res = await templateApi.update(editing.id, body);
    } else {
      const body = buildCreateBody(form);
      if (!body) {
        setBusy(false);
        setError("Forma ma'lumoti noto'g'ri");
        return;
      }
      res = await templateApi.create(body);
    }
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    onSaved();
    onClose();
  }

  return (
    <Dialog labelledBy="tf-title" onClose={onClose} maxWidth={680}>
      <div className="flex items-center gap-2.5 border-b border-bd px-5 py-4">
        <h2 id="tf-title" className="m-0 flex-1 text-base font-semibold">
          {editing ? "Shablonni tahrirlash" : "Yangi shablon"}
        </h2>
        <button type="button" onClick={onClose} aria-label="Yopish" className="flex border-0 bg-transparent p-1 text-mu" style={{ cursor: "pointer" }}>
          <IconClose size={18} />
        </button>
      </div>
      <div className="flex flex-col gap-4 px-5 py-[18px]">
        <label className="flex flex-col gap-2">
          <span className="lbl">Nom</span>
          <input className="field" value={form.name} maxLength={80} onChange={(e) => set("name", e.target.value)} placeholder="Masalan: Testlarni yurgiz va tuzat" />
          {touched && errors.name && <span className="text-xs text-red">{errors.name}</span>}
        </label>
        <label className="flex flex-col gap-2">
          <span className="lbl">Tavsif (ixtiyoriy)</span>
          <input className="field" value={form.description} maxLength={300} onChange={(e) => set("description", e.target.value)} />
        </label>

        <div className="flex flex-col gap-2" role="group" aria-labelledby="tf-scope">
          <span id="tf-scope" className="lbl">
            Ko&apos;lam
          </span>
          <div className="segs" style={{ display: "flex", gap: 4 }}>
            {SCOPE_ORDER.slice()
              .reverse()
              .map((s) => (
                <button key={s} type="button" disabled={!!editing} className={`seg flex-1 ${form.scope === s ? "on" : ""}`} aria-pressed={form.scope === s} onClick={() => set("scope", s)} style={{ height: 34 }}>
                  {SCOPE_LABEL[s]}
                </button>
              ))}
          </div>
          {form.scope === "project" && (
            <select className="field" disabled={!!editing} value={form.projectId} onChange={(e) => set("projectId", e.target.value)} aria-label="Loyiha">
              <option value="">Loyihani tanlang…</option>
              {(projects?.items ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} · {p.machineSlug}
                </option>
              ))}
            </select>
          )}
          {form.scope === "repo" && (
            <>
              <input className="field" list="tf-repos" disabled={!!editing} value={form.repoKey} onChange={(e) => set("repoKey", e.target.value)} placeholder="github.com/org/repo" spellCheck={false} aria-label="Repo kaliti" />
              <datalist id="tf-repos">
                {repoKeys.map((k) => (
                  <option key={k} value={k} />
                ))}
              </datalist>
            </>
          )}
          {touched && (errors.projectId || errors.repoKey) && <span className="text-xs text-red">{errors.projectId ?? errors.repoKey}</span>}
        </div>

        <div className="flex flex-col gap-2">
          <span className="lbl">Matn</span>
          <div className="flex flex-wrap gap-1.5" aria-label="O'zgaruvchilar">
            {rows.map((r) => (
              <button key={r.name} type="button" className="btn h-7 text-xs mono" title={r.help} onClick={() => insert(r.name)}>
                {r.token}
              </button>
            ))}
          </div>
          <textarea
            ref={area}
            rows={8}
            value={form.body}
            maxLength={16000}
            onChange={(e) => set("body", e.target.value)}
            className="resize-y rounded-lg border border-bd bg-s1 px-3 py-2.5 text-tx"
            style={{ font: "13px/1.5 var(--font-sans)" }}
            placeholder="{{project}} loyihasida testlarni yurgiz…"
            aria-label="Shablon matni"
          />
          {touched && errors.body && <span className="text-xs text-red">{errors.body}</span>}
          <details className="text-xs text-mu">
            <summary style={{ cursor: "pointer" }}>O&apos;zgaruvchilar yordami</summary>
            <table className="mt-2 w-full text-left">
              <tbody>
                {rows.map((r) => (
                  <tr key={r.name}>
                    <td className="mono py-0.5 pr-3 text-tx">{r.token}</td>
                    <td>{r.help}</td>
                  </tr>
                ))}
                <tr>
                  <td className="mono py-0.5 pr-3 text-tx">{"\\{{"}</td>
                  <td>Literal {"{{"} yozish (escape)</td>
                </tr>
              </tbody>
            </table>
            <p className="mb-0 mt-1">Qiymat markazda to&apos;ldiriladi; to&apos;ldirilgan matn saqlanmaydi. Shablonda sir (token/kalit) bo&apos;lmasin.</p>
          </details>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-2">
            <span className="lbl">Default model (ixtiyoriy)</span>
            <select className="field" value={form.model} onChange={(e) => set("model", e.target.value)}>
              <option value="">— tanlanmagan —</option>
              {MODEL_OPTIONS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-2">
            <span className="lbl">Default rejim (ixtiyoriy)</span>
            <select className="field" value={form.permissionMode} onChange={(e) => set("permissionMode", e.target.value as TemplateForm["permissionMode"])}>
              <option value="">— tanlanmagan —</option>
              {TEMPLATE_MODES.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="flex items-start gap-2">
          <input type="checkbox" className="mt-0.5" checked={form.bigTask} onChange={(e) => set("bigTask", e.target.checked)} data-testid="template-big-task" />
          <span className="flex flex-col">
            <span>Katta vazifa (avto-checkpoint)</span>
            <span className="text-xs text-mu">Shu shablon bilan sessiya ochishdan oldin ishchi daraxt checkpoint&apos;i olinadi (Checkpointlar sozlamasida «Katta vazifa» yoqilgan bo&apos;lsa).</span>
          </span>
        </label>
        {error && (
          <div role="alert" className="rounded-lg bg-red-bg px-3 py-2 text-xs text-red">
            {error}
          </div>
        )}
      </div>
      <div className="flex items-center justify-end gap-2 border-t border-bd px-5 py-3.5">
        <button type="button" className="btn" onClick={onClose}>
          Bekor
        </button>
        <button type="button" className="btn btn-pri" disabled={busy} onClick={() => void save()}>
          {busy ? "Saqlanmoqda…" : "Saqlash"}
        </button>
      </div>
    </Dialog>
  );
}
