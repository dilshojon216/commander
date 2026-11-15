"use client";

import type { ClientDto, ClientReportPreview, ClientReportSnapshotDto, BillingProjectDto } from "@commander/contracts";
import { useCallback, useEffect, useState } from "react";
import { useLiveData } from "@/components/LiveData";
import { ApiErrorBar } from "@/components/ui/States";
import { REPORT_PRIVACY_NOTE, formatBytes, periodRange } from "@/lib/billing-view";
import type { PeriodForm } from "@/lib/billing-view";
import { formatDateTime } from "@/lib/format";
import { downloadFile } from "./download";
import { PeriodPicker } from "./PeriodPicker";
import { createReport, fetchReportPreview, fetchSnapshots } from "./useBilling";

/**
 * 6.8 mijoz hisoboti: markaz ommaga ochilmaydi, shu sabab hisobot = yuklab olinadigan statik HTML + PDF. Ko'rib chiqish
 * sandbox iframe'da (skriptsiz); yaratish jurnalga yoziladi (elevation). Telegram: faqat egasi chatiga.
 */
export function ClientReportPanel({ clients, projects, period, onPeriod }: { clients: ClientDto[]; projects: BillingProjectDto[]; period: PeriodForm; onPeriod: (p: PeriodForm) => void }) {
  const { lockdown, canControl } = useLiveData();
  const [scope, setScope] = useState<string>(""); // "c:<id>" | "p:<key>"
  const [showHours, setShowHours] = useState(false);
  const [showSummary, setShowSummary] = useState(true);
  const [sendTg, setSendTg] = useState(false);
  const [preview, setPreview] = useState<{ data: ClientReportPreview; key: string } | null>(null);
  const [busy, setBusy] = useState<"preview" | "create" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [log, setLog] = useState<ClientReportSnapshotDto[]>([]);
  const blocked = lockdown ? "Lockdown yoqiq" : !canControl ? "Boshqaruv tokeni sozlanmagan" : null;
  const range = periodRange(period);

  const loadLog = useCallback(() => {
    void fetchSnapshots().then((r) => {
      if (r.ok) setLog(r.value);
    });
  }, []);
  useEffect(() => loadLog(), [loadLog]);

  const target: { clientId?: string; projectKey?: string } | null = scope.startsWith("c:") ? { clientId: scope.slice(2) } : scope.startsWith("p:") ? { projectKey: scope.slice(2) } : null;
  const ready = target !== null && range !== null;
  // Ko'rib chiqilgan ko'lam/davr/sozlama o'zgarsa, yaratishdan oldin qayta ko'rib chiqish shart
  const currentKey = JSON.stringify([scope, range, showHours, showSummary]);
  const previewFresh = preview !== null && preview.key === currentKey;

  async function doPreview() {
    if (!ready || !range) return;
    setBusy("preview");
    setError(null);
    setInfo(null);
    const params: Record<string, string> = { from: range.from, to: range.to, showHours: showHours ? "1" : "0", showSummary: showSummary ? "1" : "0" };
    if (target.clientId) params.clientId = target.clientId;
    if (target.projectKey) params.projectKey = target.projectKey;
    const r = await fetchReportPreview(new URLSearchParams(params).toString());
    setBusy(null);
    if (r.ok) setPreview({ data: r.value, key: currentKey });
    else {
      setPreview(null);
      setError(r.error);
    }
  }

  async function doCreate() {
    if (!ready || !range) return;
    setBusy("create");
    setError(null);
    const r = await createReport({ ...(target.clientId ? { clientId: target.clientId } : { projectKey: target.projectKey }), from: range.from, to: range.to, showHours, showSummary, sendToOwnerTelegram: sendTg });
    setBusy(null);
    if (!r.ok) {
      setError(r.error);
      return;
    }
    downloadFile(r.value.html);
    downloadFile(r.value.pdf);
    const tg = r.value.telegramDelivered;
    setInfo(`Yaratildi: ${r.value.html.filename} (${formatBytes(r.value.html.sizeBytes)}) va PDF. SHA-256: ${r.value.snapshot.htmlSha256.slice(0, 12)}…${tg === null ? "" : tg > 0 ? " Telegram'ga (faqat sizga) yuborildi." : " Telegram'ga yuborilmadi (bot o'chiq yoki chat yo'q)."}`);
    loadLog();
  }

  return (
    <div className="flex flex-col gap-3.5">
      <div className="rounded-md bg-blue-bg px-3 py-2 text-xs text-tx" role="note">
        {REPORT_PRIVACY_NOTE}
      </div>
      <div className="card flex flex-col gap-3 p-4">
        <PeriodPicker value={period} onChange={onPeriod} />
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1">
            <span className="lbl">Ko&apos;lam</span>
            <select className="field" style={{ width: 280, fontFamily: "var(--font-sans)" }} value={scope} onChange={(e) => setScope(e.target.value)}>
              <option value="">Tanlang…</option>
              <optgroup label="Mijoz (barcha loyihalari)">
                {clients.map((c) => (
                  <option key={c.id} value={`c:${c.id}`} disabled={c.projectKeys.length === 0}>
                    {c.name}
                    {c.projectKeys.length === 0 ? " (loyiha yo'q)" : ""}
                  </option>
                ))}
              </optgroup>
              <optgroup label="Bitta loyiha">
                {projects.map((p) => (
                  <option key={p.projectKey} value={`p:${p.projectKey}`}>
                    {p.name}
                  </option>
                ))}
              </optgroup>
            </select>
          </label>
          <label className="flex items-center gap-2 pb-2">
            <input type="checkbox" checked={showSummary} onChange={(e) => setShowSummary(e.target.checked)} /> Haftalik xulosa
          </label>
          <label className="flex items-center gap-2 pb-2">
            <input type="checkbox" checked={showHours} onChange={(e) => setShowHours(e.target.checked)} /> Soatlarni ko&apos;rsatish
          </label>
          <label className="flex items-center gap-2 pb-2" title="Fayllar faqat sizning Telegram chatingizga yuboriladi, mijozga emas">
            <input type="checkbox" checked={sendTg} onChange={(e) => setSendTg(e.target.checked)} /> Telegram&apos;ga yuborish (faqat menga)
          </label>
          <div className="ml-auto flex gap-2">
            <button type="button" className="btn" disabled={!ready || busy !== null} onClick={doPreview}>
              {busy === "preview" ? "Tayyorlanmoqda…" : "Ko'rib chiqish"}
            </button>
            <button type="button" className="btn btn-pri" disabled={!ready || busy !== null || !previewFresh || !!blocked} title={blocked ?? (previewFresh ? undefined : "Avval ko'rib chiqing (sozlama o'zgargan bo'lsa qayta)")} onClick={doCreate}>
              {busy === "create" ? "Yaratilmoqda…" : "Yaratish va yuklab olish (HTML + PDF)"}
            </button>
          </div>
        </div>
      </div>
      <ApiErrorBar error={error} />
      {info && (
        <div role="status" className="rounded-md bg-grn-bg px-3 py-2 text-grn">
          {info}
        </div>
      )}
      {preview && (
        <div className="card overflow-hidden">
          <div className="flex items-center gap-3 border-b border-bd px-4 py-2.5 text-xs text-mu">
            <span className="font-semibold text-tx">Ko&apos;rib chiqish</span>
            <span>Mijoz aynan shuni ko&apos;radi. Tekshirib chiqing, so&apos;ng yarating.</span>
            <span className="ml-auto">
              {preview.data.model.progress.done}/{preview.data.model.progress.total} bajarildi
            </span>
          </div>
          <ReportFrame html={preview.data.html} />
        </div>
      )}
      <div className="card overflow-x-auto">
        <div className="border-b border-bd px-4 py-2.5 text-sm font-semibold">Yaratilgan hisobotlar jurnali</div>
        {log.length === 0 ? (
          <p className="m-0 px-4 py-3 text-sm text-mu">Hali hisobot yaratilmagan.</p>
        ) : (
          <table className="dtable">
            <thead>
              <tr>
                <th>Qachon</th>
                <th>Mijoz / loyiha</th>
                <th>Davr</th>
                <th>Kim</th>
                <th>Hajm</th>
                <th>SHA-256 (HTML)</th>
                <th>Telegram</th>
              </tr>
            </thead>
            <tbody>
              {log.map((s) => (
                <tr key={s.id}>
                  <td>{formatDateTime(s.createdAt)}</td>
                  <td>{s.clientName}</td>
                  <td className="mono">
                    {s.periodFrom} – {s.periodTo}
                  </td>
                  <td>{s.actorKind}</td>
                  <td>{formatBytes(s.htmlBytes)} / {formatBytes(s.pdfBytes)}</td>
                  <td className="mono" title={s.htmlSha256}>
                    {s.htmlSha256.slice(0, 12)}…
                  </td>
                  <td>{s.telegramSentAt ? formatDateTime(s.telegramSentAt) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

/** sandbox="" = skript, forma, havola, same-origin YO'Q; hujjatning o'zi ham CSP (`default-src 'none'`) bilan yopiq. */
export function ReportFrame({ html }: { html: string }) {
  return <iframe title="Mijoz hisoboti ko'rinishi" sandbox="" srcDoc={html} className="block h-[640px] w-full border-0 bg-white" referrerPolicy="no-referrer" />;
}
