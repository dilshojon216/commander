"use client";

import type { ClientDto } from "@commander/contracts";
import { useMemo, useState } from "react";
import { useLiveData } from "@/components/LiveData";
import { Dialog } from "@/components/ui/Dialog";
import { IconClose, IconPlus } from "@/components/ui/icons";
import { ApiErrorBar, EmptyState } from "@/components/ui/States";
import { EMPTY_CLIENT_FORM, clientBody, formFromClient, formatRate, projectChoices } from "@/lib/billing-view";
import type { ClientForm } from "@/lib/billing-view";
import type { useBillingClients } from "./useBilling";

type Api = ReturnType<typeof useBillingClients>;

/** Mijozlar: yaratish/tahrirlash/o'chirish (elevation) va loyiha guruhlarini bog'lash. */
export function ClientsPanel({ api }: { api: Api }) {
  const { lockdown, canControl } = useLiveData();
  const [form, setForm] = useState<{ editing: ClientDto | null } | null>(null);
  const [mapping, setMapping] = useState<ClientDto | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const blocked = lockdown ? "Lockdown yoqiq" : !canControl ? "Boshqaruv tokeni sozlanmagan" : null;

  async function remove(c: ClientDto) {
    if (!window.confirm(`"${c.name}" mijozini o'chirasizmi? Loyiha bog'lanishlari ham o'chadi (loyihalarning o'zi qoladi).`)) return;
    setActionError(null);
    const r = await api.remove(c.id);
    if (!r.ok) setActionError(r.error);
  }

  return (
    <div className="flex flex-col gap-3.5">
      <div className="flex items-center gap-3">
        <p className="m-0 flex-1 text-sm text-mu">Mijoz = nom + (ixtiyoriy) soatlik stavka. Bir mijozga ko&apos;p loyiha biriktiriladi; loyiha = bir xil repo (barcha mashinalarda bitta guruh).</p>
        <button type="button" className="btn btn-pri" disabled={!!blocked} title={blocked ?? undefined} onClick={() => setForm({ editing: null })}>
          <IconPlus size={14} /> Mijoz qo&apos;shish
        </button>
      </div>
      <ApiErrorBar error={api.error} />
      {actionError && (
        <div role="alert" className="rounded-md bg-red-bg px-3 py-2 text-red">
          {actionError}
        </div>
      )}
      {api.loaded && api.clients.length === 0 ? (
        <EmptyState title="Mijoz yo'q">Birinchi mijozni qo&apos;shing, so&apos;ng unga loyihalarni biriktiring.</EmptyState>
      ) : (
        <div className="card overflow-x-auto">
          <table className="dtable">
            <thead>
              <tr>
                <th>Mijoz</th>
                <th>Stavka</th>
                <th>Loyihalar</th>
                <th>Izoh</th>
                <th aria-label="Amallar" />
              </tr>
            </thead>
            <tbody>
              {api.clients.map((c) => (
                <tr key={c.id}>
                  <td className="font-semibold">{c.name}</td>
                  <td>{formatRate({ hourlyRate: c.hourlyRate, rateCurrency: c.hourlyRate === null ? null : c.currency })}</td>
                  <td>{c.projectKeys.length === 0 ? <span className="text-mu">—</span> : `${c.projectKeys.length} ta`}</td>
                  <td className="max-w-[260px] truncate text-mu" title={c.notes}>
                    {c.notes || "—"}
                  </td>
                  <td>
                    <div className="flex justify-end gap-2">
                      <button type="button" className="btn" disabled={!!blocked} onClick={() => setMapping(c)}>
                        Loyihalar
                      </button>
                      <button type="button" className="btn" disabled={!!blocked} onClick={() => setForm({ editing: c })}>
                        Tahrirlash
                      </button>
                      <button type="button" className="btn btn-no" disabled={!!blocked} onClick={() => remove(c)}>
                        O&apos;chirish
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {form && <ClientFormDialog api={api} editing={form.editing} onClose={() => setForm(null)} />}
      {mapping && <ProjectsDialog api={api} client={mapping} onClose={() => setMapping(null)} />}
    </div>
  );
}

function DialogHead({ id, title, onClose }: { id: string; title: string; onClose: () => void }) {
  return (
    <div className="flex items-center gap-2.5 border-b border-bd px-5 py-4">
      <h2 id={id} className="m-0 flex-1 text-base font-semibold">
        {title}
      </h2>
      <button type="button" onClick={onClose} aria-label="Yopish" className="flex border-0 bg-transparent p-1 text-mu" style={{ cursor: "pointer" }}>
        <IconClose size={18} />
      </button>
    </div>
  );
}

function ClientFormDialog({ api, editing, onClose }: { api: Api; editing: ClientDto | null; onClose: () => void }) {
  const [f, setF] = useState<ClientForm>(editing ? formFromClient(editing) : EMPTY_CLIENT_FORM);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const built = clientBody(f);

  async function save() {
    if (!built.ok) {
      setError(built.error);
      return;
    }
    setBusy(true);
    setError(null);
    const r = editing ? await api.update(editing.id, built.body) : await api.create(built.body);
    setBusy(false);
    if (r.ok) onClose();
    else setError(r.error);
  }

  return (
    <Dialog labelledBy="cf-title" onClose={onClose}>
      <DialogHead id="cf-title" title={editing ? "Mijozni tahrirlash" : "Mijoz qo'shish"} onClose={onClose} />
      <div className="flex flex-col gap-4 px-5 py-[18px]">
        <label className="flex flex-col gap-2">
          <span className="lbl">Nom</span>
          <input className="field" style={{ fontFamily: "var(--font-sans)" }} value={f.name} maxLength={120} onChange={(e) => setF({ ...f, name: e.target.value })} autoComplete="off" />
        </label>
        <div className="flex gap-3">
          <label className="flex flex-1 flex-col gap-2">
            <span className="lbl">Soatlik stavka (ixtiyoriy)</span>
            <input className="field" inputMode="decimal" placeholder="150000" value={f.hourlyRate} onChange={(e) => setF({ ...f, hourlyRate: e.target.value })} />
          </label>
          <label className="flex flex-col gap-2">
            <span className="lbl">Valyuta</span>
            <select className="field" style={{ width: 110, fontFamily: "var(--font-sans)" }} value={f.currency} onChange={(e) => setF({ ...f, currency: e.target.value === "USD" ? "USD" : "UZS" })}>
              <option value="UZS">UZS</option>
              <option value="USD">USD</option>
            </select>
          </label>
        </div>
        <label className="flex flex-col gap-2">
          <span className="lbl">Izoh</span>
          <textarea rows={3} value={f.notes} maxLength={2000} onChange={(e) => setF({ ...f, notes: e.target.value })} className="resize-y rounded-lg border border-bd bg-s1 px-3 py-2.5 text-tx" style={{ font: "13px/1.5 var(--font-sans)" }} />
        </label>
        {error && (
          <div role="alert" className="rounded-md bg-red-bg px-3 py-2 text-red">
            {error}
          </div>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn" onClick={onClose}>
            Bekor qilish
          </button>
          <button type="button" className="btn btn-pri" disabled={busy || !built.ok} onClick={save}>
            {busy ? "Saqlanmoqda…" : "Saqlash"}
          </button>
        </div>
      </div>
    </Dialog>
  );
}

function ProjectsDialog({ api, client, onClose }: { api: Api; client: ClientDto; onClose: () => void }) {
  const choices = useMemo(() => projectChoices(api.projects, client.id, api.clients), [api.projects, api.clients, client.id]);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set(client.projectKeys));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = (k: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });

  async function save() {
    setBusy(true);
    setError(null);
    const r = await api.setProjects(client.id, [...selected]);
    setBusy(false);
    if (r.ok) onClose();
    else setError(r.error);
  }

  return (
    <Dialog labelledBy="cp-title" onClose={onClose} maxWidth={620}>
      <DialogHead id="cp-title" title={`${client.name}: loyihalar`} onClose={onClose} />
      <div className="flex flex-col gap-3 px-5 py-[18px]">
        <p className="m-0 text-xs text-mu">Boshqa mijozga biriktirilgan loyihani tanlasangiz, u shu mijozga ko&apos;chadi.</p>
        <div className="flex max-h-[360px] flex-col gap-1.5 overflow-y-auto">
          {choices.length === 0 && <span className="text-mu">Loyiha topilmadi (sessiya ochilgach paydo bo&apos;ladi).</span>}
          {choices.map((p) => (
            <label key={p.projectKey} className={`opt ${selected.has(p.projectKey) ? "on" : ""}`}>
              <input type="checkbox" checked={selected.has(p.projectKey)} onChange={() => toggle(p.projectKey)} />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{p.name}</span>
                <span className="mono block truncate text-xs text-mu">{p.repoKey ?? "lokal papka"} · {p.machines} mashina</span>
              </span>
              {p.otherClient && <span className="pill bg-yel-bg text-yel">{p.otherClient}</span>}
            </label>
          ))}
        </div>
        {error && (
          <div role="alert" className="rounded-md bg-red-bg px-3 py-2 text-red">
            {error}
          </div>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn" onClick={onClose}>
            Bekor qilish
          </button>
          <button type="button" className="btn btn-pri" disabled={busy} onClick={save}>
            {busy ? "Saqlanmoqda…" : `Saqlash (${selected.size})`}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
