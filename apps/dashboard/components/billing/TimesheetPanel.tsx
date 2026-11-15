"use client";

import type { BillingCurrency, ClientDto } from "@commander/contracts";
import { useMemo, useState } from "react";
import { EmptyState, ApiErrorBar, SkeletonCard } from "@/components/ui/States";
import { FX_RE, formatBytes, timesheetQuery, timesheetRows, timesheetSummaryLine, timesheetWarnings } from "@/lib/billing-view";
import type { PeriodForm } from "@/lib/billing-view";
import { downloadFile } from "./download";
import { PeriodPicker } from "./PeriodPicker";
import { fetchExport, useTimesheet } from "./useBilling";

const PLAN_TONE = { ok: "text-grn", warn: "text-yel", over: "text-red" } as const;
const FORMATS = [
  { id: "xlsx", label: "Excel (.xlsx)" },
  { id: "csv", label: "CSV" },
  { id: "pdf", label: "PDF" },
] as const;

/** "Hisob-kitob": davr + mijoz/valyuta filtri, jadval (mijoz -> loyiha -> vazifa), eksport (read, elevation talab qilinmaydi). */
export function TimesheetPanel({ clients, period, onPeriod }: { clients: ClientDto[]; period: PeriodForm; onPeriod: (p: PeriodForm) => void }) {
  const [clientId, setClientId] = useState("");
  const [currency, setCurrency] = useState<BillingCurrency | "">("");
  const [fx, setFx] = useState("");
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [exportMsg, setExportMsg] = useState<string | null>(null);
  const [busyFmt, setBusyFmt] = useState<string | null>(null);

  const filters = { period, clientId, currency, fx };
  const query = timesheetQuery(filters);
  const { dto, loading, error } = useTimesheet(query);
  const rows = useMemo(() => (dto ? timesheetRows(dto, expanded) : []), [dto, expanded]);
  const fxBad = currency !== "" && fx.trim() !== "" && !FX_RE.test(fx.trim());

  const toggle = (id: string) =>
    setExpanded((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  async function doExport(format: "xlsx" | "csv" | "pdf") {
    const q = timesheetQuery(filters, { format });
    if (!q) return;
    setBusyFmt(format);
    setExportMsg(null);
    const r = await fetchExport(q);
    setBusyFmt(null);
    if (!r.ok) {
      setExportMsg(r.error);
      return;
    }
    downloadFile(r.value);
    setExportMsg(`${r.value.filename} yuklandi (${formatBytes(r.value.sizeBytes)})`);
  }

  return (
    <div className="flex flex-col gap-3.5">
      <div className="card flex flex-col gap-3 p-4">
        <PeriodPicker value={period} onChange={onPeriod} />
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1">
            <span className="lbl">Mijoz</span>
            <select className="field" style={{ width: 200, fontFamily: "var(--font-sans)" }} value={clientId} onChange={(e) => setClientId(e.target.value)}>
              <option value="">Hammasi</option>
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="lbl">Valyuta</span>
            <select className="field" style={{ width: 170, fontFamily: "var(--font-sans)" }} value={currency} onChange={(e) => setCurrency(e.target.value as BillingCurrency | "")}>
              <option value="">Mijoz valyutasida</option>
              <option value="UZS">UZS</option>
              <option value="USD">USD</option>
            </select>
          </label>
          {currency !== "" && (
            <label className="flex flex-col gap-1">
              <span className="lbl">Kurs: 1 USD = ? UZS (qo&apos;lda)</span>
              <input className="field" style={{ width: 170 }} inputMode="decimal" placeholder="12600" value={fx} onChange={(e) => setFx(e.target.value)} aria-invalid={fxBad} />
            </label>
          )}
          <div className="ml-auto flex flex-wrap gap-2" role="group" aria-label="Eksport">
            {FORMATS.map((f) => (
              <button key={f.id} type="button" className="btn" disabled={query === null || busyFmt !== null || fxBad} onClick={() => doExport(f.id)}>
                {busyFmt === f.id ? "Tayyorlanmoqda…" : f.label}
              </button>
            ))}
          </div>
        </div>
        {fxBad && <span className="text-xs text-red">Kurs musbat son bo&apos;lsin (masalan 12600 yoki 12650.5)</span>}
        {exportMsg && (
          <span role="status" className="text-xs text-mu">
            {exportMsg}
          </span>
        )}
      </div>

      <ApiErrorBar error={error} />
      {loading && !dto && <SkeletonCard lines={5} />}
      {dto && (
        <>
          <div className="text-sm text-mu" data-testid="timesheet-summary">
            {timesheetSummaryLine(dto)}
          </div>
          {timesheetWarnings(dto).map((w) => (
            <div key={w} role="status" className="rounded-md bg-yel-bg px-3 py-2 text-xs text-tx">
              {w}
            </div>
          ))}
          {rows.length === 0 ? (
            <EmptyState title="Bu davrda faoliyat yo'q">Mijozga loyiha biriktirilganini va davrni tekshiring.</EmptyState>
          ) : (
            <div className="card overflow-x-auto">
              <table className="dtable">
                <thead>
                  <tr>
                    <th>Mijoz / loyiha / vazifa</th>
                    <th>Faol (s:daq)</th>
                    <th>Sessiya</th>
                    <th>Yopilgan</th>
                    <th>Commit</th>
                    <th>Token</th>
                    <th title="API-ekvivalent narx: obuna uchun haqiqiy to'lov emas">Narx (API-ekv.)</th>
                    <th>Reja vs haqiqiy</th>
                    <th>Summa</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} className={r.level === "client" ? "font-semibold" : ""}>
                      <td style={{ paddingLeft: r.level === "client" ? undefined : r.level === "project" ? 24 : 44 }}>
                        {r.level !== "task" ? (
                          <button type="button" className="border-0 bg-transparent p-0 text-left text-tx" style={{ cursor: "pointer", font: "inherit" }} aria-expanded={expanded.has(r.id)} onClick={() => toggle(r.id)}>
                            {expanded.has(r.id) ? "▾" : "▸"} {r.label}
                          </button>
                        ) : (
                          r.label
                        )}
                        {r.sub && <div className="text-xs font-normal text-mu">{r.sub}</div>}
                      </td>
                      <td className="mono">{r.hours}</td>
                      <td>{r.sessions}</td>
                      <td>{r.closed}</td>
                      <td>{r.commits}</td>
                      <td>{r.tokens}</td>
                      <td>{r.cost}</td>
                      <td className={r.plan ? PLAN_TONE[r.plan.tone] : "text-mu"}>{r.plan?.text ?? "—"}</td>
                      <td>{r.amount ?? (r.note ? <span className="text-xs font-normal text-mu">{r.note}</span> : "—")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="m-0 text-xs text-mu">
            Faol vaqt = sessiya ishlayotgan yoki ruxsat kutayotgan vaqt (bitta oraliq &le; 4 soat), parallel sessiyalar ikki marta sanalmaydi. Summa = daqiqalar &times; stavka / 60. Narx API-ekvivalent: obuna uchun haqiqiy to&apos;lov emas.
          </p>
        </>
      )}
    </div>
  );
}
