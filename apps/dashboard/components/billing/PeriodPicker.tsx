"use client";

import { useState } from "react";
import { monthOptions, validatePeriod } from "@/lib/billing-view";
import type { PeriodForm } from "@/lib/billing-view";

/** Davr tanlash: oy (Toshkent) yoki ixtiyoriy oraliq. Xato matni ostida. */
export function PeriodPicker({ value, onChange }: { value: PeriodForm; onChange: (p: PeriodForm) => void }) {
  const [months] = useState(() => monthOptions(Date.now(), 18));
  const error = validatePeriod(value);
  return (
    <div className="flex flex-wrap items-end gap-3">
      <div className="flex gap-1" role="group" aria-label="Davr turi">
        <button type="button" className={`seg ${value.mode === "month" ? "on" : ""}`} aria-pressed={value.mode === "month"} onClick={() => onChange({ ...value, mode: "month" })}>
          Oy
        </button>
        <button type="button" className={`seg ${value.mode === "range" ? "on" : ""}`} aria-pressed={value.mode === "range"} onClick={() => onChange({ ...value, mode: "range" })}>
          Oraliq
        </button>
      </div>
      {value.mode === "month" ? (
        <label className="flex flex-col gap-1">
          <span className="lbl">Oy</span>
          <select className="field" style={{ width: 180, fontFamily: "var(--font-sans)" }} value={value.month} onChange={(e) => onChange({ ...value, month: e.target.value })}>
            {months.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <>
          <label className="flex flex-col gap-1">
            <span className="lbl">Dan</span>
            <input className="field" style={{ width: 150 }} type="date" value={value.from} onChange={(e) => onChange({ ...value, from: e.target.value })} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="lbl">Gacha</span>
            <input className="field" style={{ width: 150 }} type="date" value={value.to} onChange={(e) => onChange({ ...value, to: e.target.value })} />
          </label>
        </>
      )}
      {error && (
        <span role="alert" className="text-xs text-red">
          {error}
        </span>
      )}
      <span className="text-xs text-mu">Sanalar Asia/Tashkent bo&apos;yicha</span>
    </div>
  );
}
