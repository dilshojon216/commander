"use client";

import type { ReportSettings } from "@commander/contracts";
import { useState } from "react";
import { WEEKDAY_OPTIONS, settingsToForm, validateReportSettings } from "@/lib/reports-view";
import type { ReportSettingsErrors, ReportSettingsForm as FormState } from "@/lib/reports-view";

export interface ReportSettingsFormProps {
  initial: ReportSettings;
  canControl: boolean;
  /** PUT; xato bo'lsa `Error` tashlaydi. */
  onSave: (s: ReportSettings) => Promise<void>;
}

/** Hisobot jadvali: yoqish, vaqt (Asia/Tashkent, HH:MM), haftalik kun. */
export function ReportSettingsForm({ initial, canControl, onSave }: ReportSettingsFormProps) {
  const [form, setForm] = useState<FormState>(() => settingsToForm(initial));
  const [errors, setErrors] = useState<ReportSettingsErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const disabled = !canControl || saving;

  const submit = async () => {
    setSaved(false);
    setFormError(null);
    const r = validateReportSettings(form);
    setErrors(r.errors);
    if (!r.value) {
      setFormError("Xato qiymatlarni to'g'rilang");
      return;
    }
    setSaving(true);
    try {
      await onSave(r.value);
      setSaved(true);
    } catch (e) {
      setFormError(e instanceof Error ? e.message : "Saqlab bo'lmadi");
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      className="card flex flex-col gap-3 p-4"
      aria-label="Hisobot sozlamalari"
      data-testid="report-settings"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-3">
        <div className="flex flex-col gap-1.5">
          <label className="flex items-center gap-2 font-medium">
            <input type="checkbox" checked={form.dailyEnabled} onChange={(e) => setForm({ ...form, dailyEnabled: e.target.checked })} disabled={disabled} data-testid="rs-daily-enabled" />
            Kunlik hisobot
          </label>
          <label className="flex flex-col gap-1 text-xs text-mu">
            Vaqt (Asia/Tashkent)
            <input className="field mono" value={form.dailyTime} onChange={(e) => setForm({ ...form, dailyTime: e.target.value })} disabled={disabled} placeholder="21:00" aria-invalid={errors.dailyTime ? true : undefined} data-testid="rs-daily-time" />
            {errors.dailyTime && <span className="text-red">{errors.dailyTime}</span>}
          </label>
        </div>
        <div className="flex flex-col gap-1.5">
          <label className="flex items-center gap-2 font-medium">
            <input type="checkbox" checked={form.weeklyEnabled} onChange={(e) => setForm({ ...form, weeklyEnabled: e.target.checked })} disabled={disabled} data-testid="rs-weekly-enabled" />
            Haftalik hisobot
          </label>
          <label className="flex flex-col gap-1 text-xs text-mu">
            Vaqt (Asia/Tashkent)
            <input className="field mono" value={form.weeklyTime} onChange={(e) => setForm({ ...form, weeklyTime: e.target.value })} disabled={disabled} placeholder="20:00" aria-invalid={errors.weeklyTime ? true : undefined} data-testid="rs-weekly-time" />
            {errors.weeklyTime && <span className="text-red">{errors.weeklyTime}</span>}
          </label>
          <label className="flex flex-col gap-1 text-xs text-mu">
            Hafta kuni
            <select className="field" value={form.weeklyDay} onChange={(e) => setForm({ ...form, weeklyDay: e.target.value })} disabled={disabled} data-testid="rs-weekly-day">
              {WEEKDAY_OPTIONS.map((d) => (
                <option key={d.value} value={String(d.value)}>
                  {d.label}
                </option>
              ))}
            </select>
            {errors.weeklyDay && <span className="text-red">{errors.weeklyDay}</span>}
          </label>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" className="btn btn-ok" disabled={disabled} data-testid="rs-save">
          {saving ? "Saqlanmoqda..." : "Saqlash"}
        </button>
        {saved && (
          <span role="status" className="text-xs text-grn">
            Saqlandi
          </span>
        )}
        {formError && (
          <span role="alert" className="text-xs text-red" data-testid="rs-error">
            {formError}
          </span>
        )}
        {!canControl && <span className="text-xs text-mu">Sozlamalarni o&apos;zgartirish uchun boshqaruv token&apos;i kerak (faqat o&apos;qish).</span>}
      </div>
    </form>
  );
}
