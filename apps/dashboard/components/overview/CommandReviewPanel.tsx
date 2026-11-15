"use client";

import { CommandDtoSchema, ListCommandsResponseSchema } from "@commander/contracts";
import type { CommandDto } from "@commander/contracts";
import { useCallback, useEffect, useState } from "react";
import { z } from "zod";
import { ApiCallError, getJson, postJson } from "@/lib/client-api";

const ConfirmResponseSchema = z.object({ outcome: z.string(), command: CommandDtoSchema });
const CancelResponseSchema = z.object({ cancelled: z.boolean(), command: CommandDtoSchema });

const OUTCOME_TEXT: Record<string, string> = {
  confirmed: "Tasdiqlandi",
  not_pending: "Allaqachon hal qilingan",
  expired: "Tasdiq muddati o'tgan",
  same_device: "So'rovchi qurilma o'zini tasdiqlay olmaydi",
  lockdown: "Lockdown: buyruq rad etildi",
  lost: "Buyruq ma'lumoti yo'qolgan (qayta yarating)",
};

/**
 * H-04/H-06: to'liq ko'rib chiqishni talab qiladigan step-up buyruqlari (bajariladigan sozlama, xavfli/kesilgan prompt).
 * Telegram bularda "Tasdiqlash" bermaydi: egasi bu yerda to'liq xulosani o'qib tasdiqlaydi yoki bekor qiladi.
 */
export function CommandReviewPanel() {
  const [items, setItems] = useState<CommandDto[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await getJson("/commands?status=awaiting_confirmation&limit=20", ListCommandsResponseSchema);
      setItems(r.items.filter((c) => c.review?.required === true && c.status === "awaiting_confirmation"));
    } catch {
      setItems([]);
    }
  }, []);

  useEffect(() => {
    const first = setTimeout(() => void load(), 0);
    const t = setInterval(() => void load(), 5000);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, [load]);

  async function act(c: CommandDto, kind: "confirm" | "cancel") {
    setBusy(c.id);
    setMsg(null);
    try {
      if (kind === "confirm") {
        const r = await postJson(`/commands/${c.id}/confirm`, {}, ConfirmResponseSchema);
        setMsg(OUTCOME_TEXT[r.outcome] ?? r.outcome);
      } else {
        const r = await postJson(`/commands/${c.id}/cancel`, {}, CancelResponseSchema);
        setMsg(r.cancelled ? "Bekor qilindi" : "Allaqachon hal qilingan");
      }
    } catch (e) {
      setMsg(e instanceof ApiCallError ? e.message : "Xatolik");
    } finally {
      setBusy(null);
      void load();
    }
  }

  if (items.length === 0 && !msg) return null;
  return (
    <section className="card overflow-hidden border-org" aria-label="To'liq ko'rib chiqish talab qilinadi" data-testid="command-review">
      <div className="flex items-center gap-2.5 bg-org-bg px-4 py-3">
        <span className="dot live text-org" />
        <h2 className="m-0 text-sm font-semibold">To&apos;liq ko&apos;rib chiqing va tasdiqlang</h2>
      </div>
      {items.map((c) => (
        <div key={c.id} className="flex flex-col gap-2 border-t border-bd px-4 py-3.5" data-testid="command-review-item">
          <div className="flex flex-wrap items-center gap-2">
            <span className="pill mono bg-s3">{c.type}</span>
            <span className="mono text-mu">{c.machineSlug}</span>
            {c.cwd && <span className="mono truncate text-xs text-mu">{c.cwd}</span>}
          </div>
          <ul role="alert" className="m-0 flex list-none flex-col gap-0.5 rounded-md bg-yel-bg px-2.5 py-2 text-xs text-tx">
            {(c.review?.reasons ?? []).map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
          {c.promptPreview && <pre className="mono m-0 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md border border-bd bg-s2 px-3 py-2.5 text-xs">{c.promptPreview}</pre>}
          <div className="flex justify-end gap-2">
            <button type="button" className="btn btn-no" disabled={busy === c.id} onClick={() => void act(c, "cancel")}>
              Bekor
            </button>
            <button type="button" className="btn btn-ok" disabled={busy === c.id} onClick={() => void act(c, "confirm")} data-testid="confirm-reviewed">
              Ko&apos;rib chiqdim, tasdiqlash
            </button>
          </div>
        </div>
      ))}
      {msg && (
        <div role="status" className="border-t border-bd px-4 py-2 text-xs text-mu">
          {msg}
        </div>
      )}
    </section>
  );
}
