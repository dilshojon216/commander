"use client";

import type { StepUpExemptionResponse } from "@commander/contracts";
import { useState } from "react";
import { Dialog } from "@/components/ui/Dialog";

export const STEPUP_TOGGLE_LABEL = "Dashboard'dan qilingan amallarga Telegram tasdig'i kerak emas (passkey/Touch ID yetarli)";

export interface StepUpExemptionCardProps {
  res: StepUpExemptionResponse | null;
  /** `control` token bor (lockdown'da faqat o'chirish mumkin: markaz yoqishni rad etadi). */
  canWrite: boolean;
  lockdown: boolean;
  busy: boolean;
  message: string | null;
  failure: string | null;
  onChange: (exempt: boolean) => void;
}

/** Telegram step-up istisnosi (6.17b): dashboard boshqaruv qurilmasi uchun ikkinchi (Telegram) tasdiqni o'chirish. */
export function StepUpExemptionCard({ res, canWrite, lockdown, busy, message, failure, onChange }: StepUpExemptionCardProps) {
  const [confirming, setConfirming] = useState(false);
  if (!res) {
    return (
      <section className="card p-4 text-xs text-mu" aria-label="Telegram tasdig'i" data-testid="stepup-card">
        Yuklanmoqda…
      </section>
    );
  }
  const turningOn = !res.exempt;
  const blocked = !canWrite || busy || (turningOn && (!res.available || lockdown));
  return (
    <section className="card flex flex-col gap-3 p-4" aria-label="Telegram tasdig'i" data-testid="stepup-card">
      <h2 className="m-0 text-sm font-semibold">Telegram tasdig&apos;i (ikkinchi tasdiq)</h2>
      <p className="m-0 text-xs text-mu">
        Odatda dashboard&apos;dan sessiya ochish, prompt yuborish yoki ruxsat rejimini o&apos;zgartirish Telegram&apos;da ham tasdiqlanishi kerak. Dashboard&apos;ning o&apos;zida esa har bir xavfli amal passkey/Touch ID yoki parol bilan tasdiqlanadi. Quyidagi sozlama yoqilsa, dashboard&apos;dan qilingan amallar uchun Telegram tasdig&apos;i so&apos;ralmaydi.
      </p>
      <label className="flex items-start gap-2 text-xs">
        <input
          type="checkbox"
          checked={res.exempt}
          disabled={blocked}
          onChange={() => (turningOn ? setConfirming(true) : onChange(false))}
          data-testid="stepup-toggle"
        />
        <span>
          <b>{STEPUP_TOGGLE_LABEL}</b>
        </span>
      </label>
      <ul className="m-0 flex list-none flex-col gap-1 p-0 text-[11px] text-mu">
        <li data-testid="stepup-deploy-note">
          Deploy va orqaga qaytarish (rollback) har doim Telegram tasdig&apos;ini talab qiladi: bu sozlama ularga ta&apos;sir qilmaydi. Avtomatik (auto) rejim ham doim Telegram tasdig&apos;i bilan.
        </li>
        <li>Faqat dashboard&apos;ning boshqaruv qurilmasiga tegishli: Telegram, mobil va boshqa qurilmalar oddiy tartibda qoladi.</li>
        <li data-testid="stepup-devices">
          Faol dashboard qurilmalari: {res.dashboardDevices}
          {res.otherExemptDevices > 0 ? `. Boshqa ${res.otherExemptDevices} ta qurilma qo'lda istisnoga qo'shilgan (bu yerdan o'zgarmaydi).` : "."}
        </li>
      </ul>
      {!res.available ? (
        <div className="text-xs text-yel" data-testid="stepup-unavailable">
          Dashboard boshqaruv qurilmasi (dashboard-control) topilmadi, shuning uchun yoqib bo&apos;lmaydi.
        </div>
      ) : null}
      {turningOn && lockdown ? <div className="text-xs text-yel">Lockdown yoqiq: istisnoni yoqib bo&apos;lmaydi (o&apos;chirish mumkin).</div> : null}
      {!canWrite ? <span className="text-xs text-mu">Boshqaruv token&apos;i kerak.</span> : <span className="text-xs text-mu">O&apos;zgartirish yangi tasdiq (Touch ID/parol) talab qiladi va audit jurnaliga yoziladi.</span>}
      {message ? <span className="text-xs text-grn">{message}</span> : null}
      {failure ? (
        <div role="alert" className="text-xs text-red" data-testid="stepup-error">
          {failure}
        </div>
      ) : null}
      {confirming ? (
        <Dialog labelledBy="stepup-title" onClose={() => setConfirming(false)}>
          <div className="flex flex-col gap-3 px-5 py-4" data-testid="stepup-confirm">
            <h2 id="stepup-title" className="m-0 text-base font-semibold">
              Telegram tasdig&apos;ini o&apos;chirasizmi?
            </h2>
            <p className="m-0 text-xs text-mu">
              Dashboard&apos;ga kirgan kishi (passkey/Touch ID yoki parol bilan) sessiya ochishi, prompt yuborishi va rejimni o&apos;zgartirishi mumkin bo&apos;ladi, Telegram&apos;da ikkinchi tasdiq so&apos;ralmaydi. Deploy va rollback baribir Telegram tasdig&apos;ini talab qiladi.
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                className="btn btn-pri"
                onClick={() => {
                  setConfirming(false);
                  onChange(true);
                }}
                data-testid="stepup-confirm-yes"
              >
                Ha, o&apos;chirish
              </button>
              <button type="button" className="btn" onClick={() => setConfirming(false)}>
                Bekor qilish
              </button>
            </div>
          </div>
        </Dialog>
      ) : null}
    </section>
  );
}
