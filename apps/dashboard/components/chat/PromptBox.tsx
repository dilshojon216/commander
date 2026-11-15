"use client";

import { useState } from "react";
import { IconLock } from "@/components/ui/icons";
import type { PromptBoxState } from "@/lib/control-ui";

/**
 * Prompt maydoni (dizayn: faol / faqat ko'rish / oflayn; qo'shimcha "blocked": siyosat, lockdown ...).
 * `busy`: buyruq bajarilmoqda, yuborish o'chiq. `onSend` true qaytarsa matn tozalanadi.
 */
export function PromptBox({ state, busy = false, onSend }: { state: PromptBoxState; busy?: boolean; onSend?: (text: string) => Promise<boolean> | boolean }) {
  const [text, setText] = useState("");
  if (state.kind !== "active") {
    return (
      <div className="flex items-center gap-2.5 rounded-[10px] border border-dashed border-bd bg-s2 px-3.5 py-3 text-mu" data-testid="prompt-disabled" data-mode={state.kind}>
        <IconLock />
        <span>{state.reason}</span>
      </div>
    );
  }
  const send = async () => {
    const v = text.trim();
    if (!v || busy) return;
    if (await onSend?.(v)) setText("");
  };
  return (
    <label className="relative block">
      <span className="sr-only">Prompt</span>
      <textarea
        rows={2}
        value={text}
        disabled={busy}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            void send();
          }
        }}
        placeholder="Claude'ga yozing… (Enter yuborish, Shift+Enter yangi qator)"
        maxLength={16000}
        className="block w-full resize-none rounded-[10px] border border-bd bg-s1 py-3 pl-3.5 pr-[120px] text-tx outline-none focus:border-blue disabled:opacity-60"
        style={{ font: "13px/1.5 var(--font-sans)" }}
      />
      <button type="button" className="btn btn-pri absolute bottom-2 right-2" disabled={busy || !text.trim()} onClick={() => void send()}>
        {busy ? "Bajarilmoqda…" : "Yuborish"}
      </button>
    </label>
  );
}
