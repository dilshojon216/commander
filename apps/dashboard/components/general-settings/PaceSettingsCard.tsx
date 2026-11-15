"use client";

import type { PaceSettingsResponse } from "@commander/contracts";
import { useState } from "react";
import { buildPaceBody, paceDraftFrom } from "@/lib/general-settings-view";
import type { PaceDraft } from "@/lib/general-settings-view";

export interface PaceSettingsCardProps {
  res: PaceSettingsResponse | null;
  /** `control` token bor va lockdown o'chiq. */
  canWrite: boolean;
  busy: boolean;
  message: string | null;
  failure: string | null;
  onSave: (body: NonNullable<ReturnType<typeof buildPaceBody>["body"]>) => void;
  onOverride: (reset: boolean) => void;
}

/** Haftalik limit tezligi (6.12): yoqish, ogohlantirish chegaralari, kechiktirish va "Bugun uchun ruxsat". */
export function PaceSettingsCard({ res, canWrite, busy, message, failure, onSave, onOverride }: PaceSettingsCardProps) {
  // Qoralama serverdan kelgan qiymat o'zgarganda (saqlangandan keyin) qayta tuziladi: "render paytida holat sozlash" namunasi
  const serverKey = res ? JSON.stringify(res.settings) : "";
  const [seen, setSeen] = useState(serverKey);
  const [draft, setDraft] = useState<PaceDraft | null>(res ? paceDraftFrom(res.settings) : null);
  const [localError, setLocalError] = useState<string | null>(null);
  if (serverKey !== seen) {
    setSeen(serverKey);
    setDraft(res ? paceDraftFrom(res.settings) : null);
    setLocalError(null);
  }

  if (!res || !draft) {
    return (
      <section className="card p-4 text-xs text-mu" aria-label="Haftalik limit tezligi" data-testid="pace-settings-card">
        Yuklanmoqda…
      </section>
    );
  }
  const parsed = buildPaceBody(draft, res.settings);
  const change = (p: Partial<PaceDraft>) => {
    setDraft({ ...draft, ...p });
    setLocalError(null);
  };
  const save = () => {
    if (!parsed.body) return setLocalError(parsed.error);
    onSave(parsed.body);
  };

  return (
    <section className="card flex flex-col gap-3 p-4" aria-label="Haftalik limit tezligi" data-testid="pace-settings-card">
      <h2 className="m-0 text-sm font-semibold">Haftalik limit tezligi</h2>
      <p className="m-0 text-xs text-mu">
        Haftalik limitni 7 kunga teng taqsimlab, har kunga qancha ulush to&apos;g&apos;ri kelishini hisoblaydi. Kun ulushining belgilangan foizi sarflansa, Telegram&apos;ga ogohlantirish keladi va shu tezlikda limit qachon tugashi ko&apos;rsatiladi. Hisob rasmiy haftalik foizga tayanadi; rasmiy ma&apos;lumot eskirsa &quot;taxmin&quot; deb belgilanadi.
      </p>

      <label className="flex items-start gap-2 text-xs">
        <input type="checkbox" checked={draft.enabled} onChange={(e) => change({ enabled: e.target.checked })} disabled={!canWrite || busy} data-testid="pace-enabled" />
        <span>
          <b>Tezlik nazorati yoqilgan.</b> O&apos;chirilsa ogohlantirishlar va kechiktirish to&apos;xtaydi (hisob-kitob ko&apos;rsatilaveradi).
        </span>
      </label>

      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1.5">
          <span className="lbl">Birinchi ogohlantirish (kun ulushining %)</span>
          <input className="field w-32" inputMode="decimal" value={draft.softPct} onChange={(e) => change({ softPct: e.target.value })} disabled={!canWrite || busy} autoComplete="off" data-testid="pace-soft" />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="lbl">Ikkinchi ogohlantirish / chegara (%)</span>
          <input className="field w-32" inputMode="decimal" value={draft.hardPct} onChange={(e) => change({ hardPct: e.target.value })} disabled={!canWrite || busy} autoComplete="off" data-testid="pace-hard" />
        </label>
      </div>
      <p className="m-0 text-[11px] text-mu">Masalan 80 va 100: bugungi ulushning 80% sarflanganda birinchi, 100% da ikkinchi ogohlantirish.</p>

      <label className="flex items-start gap-2 text-xs">
        <input type="checkbox" checked={draft.enforce} onChange={(e) => change({ enforce: e.target.checked })} disabled={!canWrite || busy} data-testid="pace-enforce" />
        <span>
          <b>Chegaraga yetganda yangi ishni kechiktirish.</b> Yoqilsa, kun ulushi tugaganda yangi sessiya, navbat va orkestratsiya vazifalari boshlanmaydi (navbatdagilar kutadi). Ishlayotgan sessiyalar to&apos;xtamaydi. Odatda o&apos;chiq: faqat ogohlantirish.
        </span>
      </label>

      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="btn btn-pri" disabled={!canWrite || busy || !parsed.body} onClick={save} data-testid="pace-save">
          {busy ? "Saqlanmoqda…" : "Saqlash"}
        </button>
        {!canWrite ? <span className="text-xs text-mu">Boshqaruv token&apos;i kerak (lockdown o&apos;chiq bo&apos;lsin).</span> : <span className="text-xs text-mu">Saqlash yangi tasdiq (Touch ID/parol) talab qiladi.</span>}
        {message ? <span className="text-xs text-grn">{message}</span> : null}
      </div>
      {localError || parsed.error || failure ? (
        <div role="alert" className="text-xs text-red" data-testid="pace-error">
          {failure ?? localError ?? parsed.error}
        </div>
      ) : null}

      <div className="flex flex-col gap-2 border-t border-bd pt-3" data-testid="pace-override">
        <b className="text-[13px]">Bugun uchun ruxsat</b>
        <p className="m-0 text-xs text-mu">
          Kechiktirish yoqilgan bo&apos;lsa ham, bugun ({res.day}) yangi ishlarni boshlashga ruxsat beradi. Yarim kechada (Toshkent vaqti) o&apos;zi tugaydi. Kechiktirish o&apos;chiq bo&apos;lsa hech narsani o&apos;zgartirmaydi.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          {res.overriddenToday ? (
            <>
              <span className="pill bg-grn-bg text-grn" data-testid="pace-override-on">
                Bugun uchun ruxsat berilgan
              </span>
              <button type="button" className="btn" disabled={!canWrite || busy} onClick={() => onOverride(true)} data-testid="pace-override-reset">
                Ruxsatni bekor qilish
              </button>
            </>
          ) : (
            <button type="button" className="btn" disabled={!canWrite || busy} onClick={() => onOverride(false)} data-testid="pace-override-btn">
              Bugun uchun ruxsat berish
            </button>
          )}
        </div>
      </div>
    </section>
  );
}
