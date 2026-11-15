"use client";

import { DEFAULT_INVESTIGATION_MODEL } from "@commander/contracts";
import { useEffect, useState } from "react";
import { ApiCallError } from "@/lib/client-api";
import { SETTINGS_ANCHOR, buildSettingsPut, validateOpsFolder } from "@/lib/investigation-view";
import { fetchInvestigationSettings, saveInvestigationSettings } from "@/lib/use-investigations";

export interface InvestigationSettingsViewProps {
  folder: string;
  model: string;
  onFolder: (v: string) => void;
  onModel: (v: string) => void;
  canControl: boolean;
  loading: boolean;
  saving: boolean;
  error: string | null;
  saved: boolean;
  onSave: () => void;
}

/** "Tekshiruv sozlamalari" formasi: faqat ko'rinish (props orqali; testlanadi). */
export function InvestigationSettingsView({ folder, model, onFolder, onModel, canControl, loading, saving, error, saved, onSave }: InvestigationSettingsViewProps) {
  const folderError = validateOpsFolder(folder);
  return (
    <section id={SETTINGS_ANCHOR} className="card flex flex-col gap-3 p-4" aria-label="Tekshiruv sozlamalari" data-testid="investigation-settings">
      <h3 className="text-sm font-semibold">Tekshiruv sozlamalari</h3>
      <p className="m-0 text-xs text-mu">
        &quot;Claude tekshirsin&quot; shu mashinadagi ops papkada plan rejimida (faqat o&apos;qish) sessiya ochadi. Papka masofadan HECH QACHON yaratilmaydi: mashinada o&apos;zingiz yarating va agentd ruxsat etilgan ildizlari ichida bo&apos;lsin (<span className="mono">agentd policy allow-root &lt;papka&gt;</span>).
      </p>
      <div className="flex flex-wrap items-start gap-3">
        <label className="flex min-w-[260px] flex-1 flex-col gap-1.5">
          <span className="lbl">Ops papka (shu mashina)</span>
          <input className="field" value={folder} onChange={(e) => onFolder(e.target.value)} placeholder="/home/user/ops-notes" spellCheck={false} autoComplete="off" disabled={loading || !canControl} aria-invalid={folderError !== null} data-testid="ops-folder" />
          {folderError ? <span className="text-xs text-red">{folderError}</span> : null}
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="lbl">Model</span>
          <input className="field" value={model} onChange={(e) => onModel(e.target.value)} placeholder={DEFAULT_INVESTIGATION_MODEL} spellCheck={false} autoComplete="off" disabled={loading || !canControl} data-testid="ops-model" />
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="btn btn-pri" disabled={loading || saving || !canControl || folderError !== null} onClick={onSave} data-testid="ops-save">
          {saving ? "Saqlanmoqda…" : "Saqlash"}
        </button>
        {!canControl ? <span className="text-xs text-mu">Boshqaruv token&apos;i kerak.</span> : null}
        {saved ? <span className="text-xs text-grn">Saqlandi</span> : null}
        <span className="text-xs text-mu">Saqlash yangi tasdiq (Touch ID/parol) talab qiladi. Bo&apos;sh papka = olib tashlash.</span>
      </div>
      {error ? (
        <div role="alert" className="text-xs text-red" data-testid="ops-error">
          {error}
        </div>
      ) : null}
    </section>
  );
}

/** Mashina sahifasi: shu mashina uchun ops papka va model (markaz sozlamalaridan o'qiladi/yoziladi). */
export function InvestigationSettingsForm({ machineId, canControl }: { machineId: string; canControl: boolean }) {
  const [folder, setFolder] = useState("");
  const [model, setModel] = useState(DEFAULT_INVESTIGATION_MODEL);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    const ctl = new AbortController();
    fetchInvestigationSettings(ctl.signal)
      .then((s) => {
        setFolder(s.opsFolders[machineId] ?? "");
        setModel(s.model);
      })
      .catch((e: unknown) => {
        if (!ctl.signal.aborted) setError(e instanceof Error ? e.message : "Sozlamalarni olib bo'lmadi");
      })
      .finally(() => {
        if (!ctl.signal.aborted) setLoading(false);
      });
    return () => ctl.abort();
  }, [machineId]);

  async function save() {
    const { body, error: e } = buildSettingsPut(machineId, { folder, model });
    if (!body) {
      setError(e);
      return;
    }
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await saveInvestigationSettings(body);
      setSaved(true);
    } catch (err) {
      setError(err instanceof ApiCallError && (err.status === 401 || err.status === 403) ? "Ruxsat yo'q: boshqaruv token'i, lockdown yoki qayta tasdiqlash kerak." : "Saqlab bo'lmadi, qayta urinib ko'ring.");
    } finally {
      setSaving(false);
    }
  }

  return <InvestigationSettingsView folder={folder} model={model} onFolder={(v) => { setFolder(v); setSaved(false); }} onModel={(v) => { setModel(v); setSaved(false); }} canControl={canControl} loading={loading} saving={saving} error={error} saved={saved} onSave={() => void save()} />;
}
