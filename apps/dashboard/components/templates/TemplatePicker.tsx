"use client";

import type { RenderTemplateResponse, TemplateDto } from "@commander/contracts";
import { useState } from "react";
import { previewStatus, scopeBadge } from "./template-vm";
import { templateApi, useTemplateList } from "./useTemplates";

/**
 * "Shablondan" tanlash (yangi sessiya oynasi va navbat formasi): shablon markazda render qilinadi va natija vazifa matniga
 * qo'yiladi (foydalanuvchi tahrirlashi mumkin). Qiymati topilmagan o'zgaruvchi matnda `{{nom}}` bo'lib qoladi va ogohlantiriladi.
 */
export function TemplatePicker({
  projectId,
  onApply,
  disabled,
}: {
  projectId: string | null;
  onApply: (r: RenderTemplateResponse, t: TemplateDto) => void;
  disabled?: boolean;
}) {
  const list = useTemplateList({ projectId });
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ tone: "warn" | "err"; text: string } | null>(null);
  if (list.loaded && list.items.length === 0) return null;

  async function pick(id: string) {
    const t = list.items.find((x) => x.id === id);
    if (!t) return;
    setBusy(true);
    setNote(null);
    const r = await templateApi.render(id, projectId ? { projectId } : {});
    setBusy(false);
    if (!r.ok) {
      setNote({ tone: "err", text: r.error });
      return;
    }
    onApply(r.value, t);
    const st = previewStatus(r.value);
    if (st.note) setNote({ tone: "warn", text: `${st.note}. Matnni o'zingiz to'ldiring.` });
  }

  return (
    <label className="flex flex-col gap-2">
      <span className="lbl">Shablondan</span>
      <select className="field" value="" disabled={disabled || busy || !list.loaded} onChange={(e) => e.target.value && void pick(e.target.value)} data-testid="template-picker">
        <option value="">{busy ? "Tayyorlanmoqda…" : "Shablon tanlang (matn to'ldiriladi)…"}</option>
        {list.items.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name} · {scopeBadge(t)}
          </option>
        ))}
      </select>
      {note && (
        <span role={note.tone === "err" ? "alert" : "status"} className={`text-xs ${note.tone === "err" ? "text-red" : "text-yel"}`}>
          {note.text}
        </span>
      )}
    </label>
  );
}
