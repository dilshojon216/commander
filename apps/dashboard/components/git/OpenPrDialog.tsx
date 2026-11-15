"use client";

import type { CommandDto } from "@commander/contracts";
import { useMemo, useState } from "react";
import { useTrackedCommand } from "@/components/control/useControl";
import { Dialog } from "@/components/ui/Dialog";
import { IconClose } from "@/components/ui/icons";
import { BASE_CHOICES, OTHER_BASE, gitErrorText, prFormDefaults, prResultOf, validatePrForm } from "@/lib/git-view";
import type { PrForm } from "@/lib/git-view";
import { useGitApi, useProjectContext } from "./useGit";

/**
 * "PR ochish": sarlavha/tana sessiya vazifasi va oxirgi commitlardan to'ldiriladi (tahrirlanadi), base branch tanlanadi.
 * Yuborilgach `project.open_pr` buyrug'i kuzatiladi: step-up bo'lsa Telegram tasdig'i kutiladi (Mac dashboard istisnosi bo'lsa darhol).
 * Branch origin'ga yuboriladi (force YO'Q) va PR faqat mashinada `gh` o'rnatilgan va avtorizatsiyadan o'tgan bo'lsa ochiladi.
 */
export function OpenPrDialog({ projectId, sessionName, taskKey, onClose }: { projectId: string; sessionName?: string | null; taskKey?: string | null; onClose: () => void }) {
  const api = useGitApi();
  const ctx = useProjectContext(projectId, taskKey);
  const [edits, setEdits] = useState<Partial<PrForm>>({});
  const [baseSel, setBaseSel] = useState<string>("main");
  const [errors, setErrors] = useState<Partial<Record<keyof PrForm, string>>>({});
  const [error, setError] = useState<string | null>(null);
  const [cmdId, setCmdId] = useState<string | null>(null);
  const cmd = useTrackedCommand(cmdId);

  const taskTitle = useMemo(() => (taskKey ? (ctx.tasks?.tasks.find((t) => t.key === taskKey)?.title ?? null) : null), [ctx.tasks, taskKey]);
  // Boshlang'ich qiymatlar kontekstdan hosil bo'ladi (effektsiz); foydalanuvchi tahrirlari ustiga yoziladi
  const defaults = useMemo(
    () => (ctx.ready ? prFormDefaults({ branch: ctx.detail?.git?.branch ?? null, taskKey: taskKey ?? null, taskTitle, sessionName: sessionName ?? null, commitSubjects: (ctx.detail?.commits ?? []).map((c) => c.subject) }) : null),
    [ctx.ready, ctx.detail, taskKey, taskTitle, sessionName],
  );
  const form: PrForm | null = defaults ? { ...defaults, ...edits } : null;
  const patch = (p: Partial<PrForm>) => setEdits((e) => ({ ...e, ...p }));
  const inflight = !!cmd && !["done", "failed", "expired", "rejected"].includes(cmd.status);
  const result = cmd ? prResultOf(cmd) : null;

  async function submit() {
    if (!form) return;
    const v = validatePrForm(form);
    if (!v.ok) {
      setErrors(v.errors);
      return;
    }
    setErrors({});
    setError(null);
    try {
      const c = await api.openPr(projectId, v.body);
      setCmdId(c.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Xatolik");
    }
  }

  return (
    <Dialog labelledBy="pr-title" onClose={onClose} maxWidth={720} top={40}>
      <div className="flex items-center gap-2.5 border-b border-bd px-5 py-4">
        <h2 id="pr-title" className="m-0 flex-1 text-base font-semibold">
          PR ochish
        </h2>
        <button type="button" onClick={onClose} aria-label="Yopish" className="flex border-0 bg-transparent p-1 text-mu" style={{ cursor: "pointer" }}>
          <IconClose size={18} />
        </button>
      </div>
      <div className="flex max-h-[70vh] flex-col gap-3 overflow-y-auto px-5 py-4">
        {!form ? (
          <div className="sk h-40" aria-busy="true" />
        ) : (
          <>
            <label className="flex flex-col gap-1 text-xs text-mu">
              Sarlavha
              <input className="field" style={{ fontFamily: "var(--font-sans)" }} value={form.title} onChange={(e) => patch({ title: e.target.value })} maxLength={256} aria-label="Sarlavha" aria-invalid={!!errors.title} data-testid="pr-title-input" />
              {errors.title && (
                <span role="alert" className="text-red">
                  {errors.title}
                </span>
              )}
            </label>
            <div className="flex flex-wrap items-end gap-3">
              <label className="flex flex-col gap-1 text-xs text-mu">
                Base branch
                <select
                  className="sel"
                  value={(BASE_CHOICES as readonly string[]).includes(form.base) ? form.base : OTHER_BASE}
                  onChange={(e) => {
                    setBaseSel(e.target.value);
                    patch({ base: e.target.value === OTHER_BASE ? "" : e.target.value });
                  }}
                  aria-label="Base branch"
                  data-testid="pr-base-select"
                >
                  {BASE_CHOICES.map((b) => (
                    <option key={b} value={b}>
                      {b}
                    </option>
                  ))}
                  <option value={OTHER_BASE}>boshqa…</option>
                </select>
              </label>
              {(baseSel === OTHER_BASE || !(BASE_CHOICES as readonly string[]).includes(form.base)) && (
                <input className="field mono" style={{ width: 200 }} value={form.base} onChange={(e) => patch({ base: e.target.value })} placeholder="base branch" aria-label="Base branch nomi" aria-invalid={!!errors.base} />
              )}
              <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs text-mu">
                Head (branch)
                <input className="field mono" value={form.head} onChange={(e) => patch({ head: e.target.value })} placeholder="bo'sh = mashinadagi joriy branch" aria-label="Head branch" aria-invalid={!!errors.head} />
              </label>
              <label className="flex items-center gap-2 pb-2 text-xs text-mu">
                <input type="checkbox" checked={form.draft} onChange={(e) => patch({ draft: e.target.checked })} />
                Draft
              </label>
            </div>
            {(errors.base || errors.head) && (
              <span role="alert" className="text-xs text-red">
                {errors.base ?? errors.head}
              </span>
            )}
            <label className="flex flex-col gap-1 text-xs text-mu">
              Tavsif
              <textarea className="field" style={{ minHeight: 180, fontFamily: "var(--font-mono)", padding: 10 }} value={form.body} onChange={(e) => patch({ body: e.target.value })} maxLength={16_000} aria-label="Tavsif" data-testid="pr-body-input" />
              {errors.body && (
                <span role="alert" className="text-red">
                  {errors.body}
                </span>
              )}
            </label>
            <span className="text-[11px] text-fa">Branch origin&apos;ga yuboriladi (force yo&apos;q). Bu masofaviy amal audit jurnaliga yoziladi va ikkinchi tasdiq (Telegram) talab qilinishi mumkin. Mashinada gh o&apos;rnatilgan va kirgan bo&apos;lishi shart.</span>
          </>
        )}
        {error && (
          <div role="alert" className="rounded-lg bg-red-bg px-3 py-2 text-xs text-red" data-testid="pr-error">
            {error}
          </div>
        )}
        {cmd && <PrStatus command={cmd} result={result} />}
      </div>
      <div className="flex flex-wrap items-center gap-2 border-t border-bd px-5 py-3.5">
        <span className="flex-1" />
        <button type="button" className="btn" onClick={onClose}>
          {result ? "Yopish" : "Bekor"}
        </button>
        <button type="button" className="btn btn-pri" disabled={!form || api.busy || inflight || !!result} onClick={() => void submit()} data-testid="pr-submit">
          PR ochish
        </button>
      </div>
    </Dialog>
  );
}

/** `project.open_pr` jarayoni: tasdiq kutilmoqda -> yuborildi -> natija (PR havolasi) yoki o'zbekcha xato. */
export function PrStatus({ command, result }: { command: CommandDto; result: ReturnType<typeof prResultOf> }) {
  const failed = command.status === "failed" || command.status === "rejected" || command.status === "expired";
  return (
    <div role="status" aria-live="polite" data-testid="pr-status" data-status={command.status} className={`rounded-lg px-3 py-2 text-xs ${failed ? "bg-red-bg text-red" : result ? "bg-grn-bg text-grn" : "bg-blue-bg text-blue"}`}>
      {result ? (
        <span>
          PR #{result.number}
          {result.existing ? " (allaqachon bor edi)" : " ochildi"}:{" "}
          <a href={result.url} target="_blank" rel="noopener noreferrer" className="underline">
            {result.url}
          </a>
        </span>
      ) : failed ? (
        <span>{gitErrorText(command.errorCode)}</span>
      ) : command.status === "awaiting_confirmation" ? (
        <span>Telegram&apos;da tasdiqlang (2 daqiqa).</span>
      ) : (
        <span>Bajarilmoqda…</span>
      )}
    </div>
  );
}
