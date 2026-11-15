"use client";

import { ApprovalDecisionResponseSchema, buildPreview, displayOptionLabel, isRecommendedLabel } from "@commander/contracts";
import type { ApprovalBehavior, ApprovalDto, AskAnswer } from "@commander/contracts";
import { useState } from "react";
import { useLiveData } from "@/components/LiveData";
import { MarkdownView } from "@/components/MarkdownView";
import { PLAN_FEEDBACK_MAX, PLAN_REMOTE_APPROVE_SUPPORTED, approvalCardModel, mapDecisionError, toolSummary } from "@/lib/approval-ui";
import type { ApprovalCardModel, CardTone, SubmitState } from "@/lib/approval-ui";
import { ApiCallError, postJson } from "@/lib/client-api";
import { machineNameMap, shortSlug } from "@/lib/machines";
import { answeredCount, draftAnswers, emptyDraft, setOtherText, toggleOther, togglePick } from "@/lib/question-ui";
import type { QuestionDraft } from "@/lib/question-ui";
import { useNow } from "@/lib/use-now";

const HEAD_BG: Record<CardTone, string> = { org: "bg-org-bg", red: "bg-red-bg", grn: "bg-grn-bg", gray: "bg-gray-bg" };
const DOT_FG: Record<CardTone, string> = { org: "text-org", red: "text-red", grn: "text-grn", gray: "text-mu" };

export interface ApprovalCardViewProps {
  approval: ApprovalDto;
  model: ApprovalCardModel;
  variant: "row" | "card";
  machine: string;
  confirming: boolean;
  submitting: boolean;
  onAsk: () => void;
  onDeny: () => void;
  onConfirm: () => void;
  onCancelConfirm: () => void;
  /** Reja (ExitPlanMode) uchun fikr matni va "fikr bilan rad" (ixtiyoriy: reja bo'lmasa kerak emas). */
  feedback?: string;
  onFeedbackChange?: (v: string) => void;
  onDenyFeedback?: () => void;
  /** AskUserQuestion (6.13): javob qoralamasi va yuborish. */
  draft?: QuestionDraft;
  onDraftChange?: (d: QuestionDraft) => void;
  onSubmitAnswers?: (answers: AskAnswer[]) => void;
}

/**
 * H-04: tool kiritmasi haqida ogohlantirish (xavfli andozalar: pipe-to-shell, curl|wget, rm -rf, ...; ko'p qismi yashirilgan;
 * yashirin boshqaruv belgilari) va ko'p qatorli/uzun matn uchun "to'liq matn" (birinchi qator ortida yashirin qolmasin).
 * Faqat ko'rinish: qaror tugmalari o'zgarmaydi.
 */
export function InputGuard({ detail, full }: { detail: string; full: boolean }) {
  const pv = buildPreview(detail, 6000);
  const expandable = full && (detail.includes("\n") || detail.length > 160 || pv.hiddenChars > 0);
  if (pv.reasons.length === 0 && !expandable) return null;
  return (
    <div className="flex flex-col gap-1.5" data-testid="input-guard">
      {pv.reasons.length > 0 && (
        <ul role="alert" className="m-0 flex list-none flex-col gap-0.5 rounded-md bg-yel-bg px-2.5 py-2 text-xs text-tx" data-testid="input-warnings">
          {pv.reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      )}
      {expandable && (
        <details data-testid="input-full">
          <summary className="cursor-pointer text-xs text-mu">To&apos;liq matn ({pv.totalChars} belgi)</summary>
          <pre className="mono m-0 mt-1 max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-md border border-bd bg-s2 px-3 py-2.5 text-xs">{pv.shown}</pre>
          {pv.truncationNote && <p className="m-0 mt-1 text-xs text-mu">{pv.truncationNote.replace("dashboard'da", "kartada kesilgan")}</p>}
        </details>
      )}
    </div>
  );
}

/** Avto-ruxsat qoidasi nishoni (2.13). */
function RuleBadge({ ruleId }: { ruleId: number }) {
  return (
    <span className="pill mono bg-grn-bg text-grn" data-testid="rule-badge" title="Avto-ruxsat qoidasi hal qildi">
      avto-ruxsat · qoida #{ruleId}
    </span>
  );
}

/** Reja kartasi (2.14): reja xavfsiz markdown sifatida, fikr maydoni, "fikr bilan rad". Tasdiqlash terminalda. */
function PlanCardView({ approval: a, model: m, machine, submitting, onDeny, onConfirm, onCancelConfirm, confirming, feedback = "", onFeedbackChange, onDenyFeedback }: ApprovalCardViewProps) {
  const timerColor = m.urgent ? "text-red" : m.active ? "text-tx" : "text-mu";
  const borderColor = m.active ? (m.urgent ? "border-red" : "border-org") : "border-bd";
  const msgColor = m.messageTone === "red" ? "text-red" : m.messageTone === "tx" ? "text-tx" : "text-mu";
  const canAct = m.showButtons && !m.buttons.deny.disabled;
  return (
    <div data-testid="approval-card" data-kind={m.kind} data-approval-type="plan" aria-label={`${m.title}: ${a.projectName ?? "loyihasiz"}`} className={`card overflow-hidden ${borderColor}`}>
      <div className={`flex items-center gap-2 px-3.5 py-2.5 ${HEAD_BG[m.tone]}`}>
        <span className={`dot ${DOT_FG[m.tone]} ${m.active ? "live" : ""}`} />
        <span className="flex-1 font-semibold">{m.title}</span>
        <span className={`mono font-semibold ${timerColor}`} suppressHydrationWarning>
          {m.timer}
        </span>
      </div>
      <div className={`flex flex-col gap-2.5 px-3.5 py-3 ${m.dim ? "opacity-70" : ""}`}>
        <div className="flex flex-wrap items-center gap-2">
          <span className="pill mono bg-s3">ExitPlanMode</span>
          <span className="font-semibold">{a.projectName ?? "(loyihasiz)"}</span>
          <span className="mono text-xs text-mu">{machine}</span>
        </div>
        {a.plan ? (
          <div className="max-h-96 overflow-auto rounded-md border border-bd bg-s2" data-testid="plan-body">
            <MarkdownView content={a.plan} className="px-3 py-2.5" />
          </div>
        ) : (
          <span className="text-xs text-mu" data-testid="plan-missing">
            Reja matni yo&apos;q (30 kundan keyin tozalanadi yoki yuborilmagan).
          </span>
        )}
        {canAct && !confirming && (
          <>
            <label className="flex flex-col gap-1 text-xs text-mu">
              Fikr (ixtiyoriy): Claude rejani shu bo&apos;yicha qayta ko&apos;rib chiqadi
              <textarea
                className="field min-h-[64px] resize-y"
                value={feedback}
                maxLength={PLAN_FEEDBACK_MAX}
                onChange={(e) => onFeedbackChange?.(e.target.value)}
                placeholder="Masalan: faqat 1 qadam qoldiring"
                data-testid="plan-feedback"
              />
            </label>
            <div className="flex flex-wrap justify-end gap-2">
              <button type="button" className="btn btn-no" disabled={submitting} onClick={onDeny} data-testid="deny">
                Rad
              </button>
              <button type="button" className="btn btn-pri" disabled={submitting || feedback.trim() === ""} onClick={onDenyFeedback} data-testid="deny-feedback">
                Fikr bilan rad etish
              </button>
              {PLAN_REMOTE_APPROVE_SUPPORTED && (
                <button type="button" className="btn btn-ok" disabled={m.buttons.allow.disabled} onClick={onConfirm} data-testid="allow">
                  Rejani tasdiqlash
                </button>
              )}
            </div>
          </>
        )}
        {confirming && (
          <div className="flex flex-wrap items-center gap-2 rounded-lg bg-yel-bg px-3 py-2.5" role="group" aria-label="Tasdiqlash">
            <span className="min-w-0 flex-1 text-tx">{machine} dagi reja tasdiqlansinmi?</span>
            <button type="button" className="btn" onClick={onCancelConfirm}>
              Bekor
            </button>
            <button type="button" className="btn btn-ok" onClick={onConfirm} disabled={submitting}>
              Ha, tasdiqlash
            </button>
          </div>
        )}
        {m.message && !confirming && (
          <span role={m.messageTone === "red" ? "alert" : undefined} className={`text-xs ${msgColor}`} data-testid="plan-note">
            {m.message}
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * AskUserQuestion kartasi (6.13): hamma savol bir kartada. Variantlar radio/checkbox, "(tavsiya)" faqat belgi (hech narsa
 * oldindan tanlanmaydi), "Boshqa" = erkin matn. Oddiy "Ruxsat" tugmasi YO'Q: javob faqat to'liq to'ldirilgach yuboriladi.
 */
function QuestionCardView({ approval: a, model: m, machine, submitting, onDeny, draft, onDraftChange, onSubmitAnswers }: ApprovalCardViewProps) {
  const qs = a.questions ?? [];
  const timerColor = m.urgent ? "text-red" : m.active ? "text-tx" : "text-mu";
  const borderColor = m.active ? (m.urgent ? "border-red" : "border-org") : "border-bd";
  const msgColor = m.messageTone === "red" ? "text-red" : m.messageTone === "tx" ? "text-tx" : "text-mu";
  const current = draft ?? emptyDraft(qs);
  const answers = draftAnswers(qs, current);
  const canAct = m.showButtons;
  const canSubmit = canAct && !m.buttons.allow.disabled && !submitting && answers !== null;
  const done = qs.length > 0 ? answeredCount(qs, current) : 0;
  return (
    <div data-testid="approval-card" data-kind={m.kind} data-approval-type="question" aria-label={`${m.title}: ${a.projectName ?? "loyihasiz"}`} className={`card overflow-hidden ${borderColor}`}>
      <div className={`flex items-center gap-2 px-3.5 py-2.5 ${HEAD_BG[m.tone]}`}>
        <span className={`dot ${DOT_FG[m.tone]} ${m.active ? "live" : ""}`} />
        <span className="flex-1 font-semibold">{m.title}</span>
        <span className={`mono font-semibold ${timerColor}`} suppressHydrationWarning>
          {m.timer}
        </span>
      </div>
      <div className={`flex flex-col gap-3 px-3.5 py-3 ${m.dim ? "opacity-70" : ""}`}>
        <div className="flex flex-wrap items-center gap-2">
          <span className="pill mono bg-s3">AskUserQuestion</span>
          <span className="font-semibold">{a.projectName ?? "(loyihasiz)"}</span>
          <span className="mono text-xs text-mu">{machine}</span>
        </div>
        {qs.length === 0 && (
          <span className="text-xs text-mu" data-testid="question-missing">
            Savol matni yo&apos;q (30 kundan keyin tozalanadi yoki yuborilmagan).
          </span>
        )}
        {qs.map((q, qi) => {
          const d = current[qi];
          const answered = a.answers?.find((x) => x.q === qi);
          return (
            <fieldset key={qi} className="m-0 flex min-w-0 flex-col gap-1.5 border-0 p-0" data-testid="question">
              <legend className="mb-1 flex flex-wrap items-center gap-2 p-0">
                {q.header && <span className="pill bg-s3 text-tx">{q.header}</span>}
                <span className="font-semibold">{q.question}</span>
                {q.multiSelect && <span className="text-xs text-mu">(bir nechtasini tanlash mumkin)</span>}
              </legend>
              {q.options.map((o, oi) => {
                const checked = canAct ? (d?.picks.includes(oi) ?? false) : (answered?.picks.includes(oi) ?? false);
                return (
                  <label key={oi} className={`flex cursor-pointer items-start gap-2 rounded-md border px-2.5 py-2 ${checked ? "border-org bg-org-bg" : "border-bd"}`} data-testid="question-option">
                    <input
                      type={q.multiSelect ? "checkbox" : "radio"}
                      name={`q-${a.id}-${qi}`}
                      className="mt-0.5"
                      checked={checked}
                      disabled={!canAct || submitting}
                      onChange={() => onDraftChange?.(togglePick(current, qs, qi, oi))}
                    />
                    <span className="flex min-w-0 flex-col gap-0.5">
                      <span>
                        {displayOptionLabel(o.label)}
                        {isRecommendedLabel(o.label) && <span className="ml-1 text-xs text-grn" data-testid="recommended-mark">★</span>}
                      </span>
                      {o.description && <span className="text-xs text-mu">{o.description}</span>}
                      {o.preview && (
                        <details>
                          <summary className="cursor-pointer text-xs text-mu">Ko&apos;rinish</summary>
                          <pre className="mono m-0 mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md border border-bd bg-s2 px-2 py-1.5 text-xs">{o.preview}</pre>
                        </details>
                      )}
                    </span>
                  </label>
                );
              })}
              {canAct ? (
                <div className={`flex flex-col gap-1.5 rounded-md border px-2.5 py-2 ${d?.useOther ? "border-org bg-org-bg" : "border-bd"}`}>
                  <label className="flex cursor-pointer items-center gap-2">
                    <input type={q.multiSelect ? "checkbox" : "radio"} name={`q-${a.id}-${qi}`} checked={d?.useOther ?? false} disabled={submitting} onChange={() => onDraftChange?.(toggleOther(current, qs, qi))} data-testid="question-other-toggle" />
                    <span>Boshqa…</span>
                  </label>
                  {d?.useOther && (
                    <input
                      type="text"
                      className="field"
                      value={d.other}
                      maxLength={1000}
                      onChange={(e) => onDraftChange?.(setOtherText(current, qi, e.target.value))}
                      placeholder="O'z javobingiz"
                      data-testid="question-other-text"
                    />
                  )}
                </div>
              ) : (
                answered?.other && (
                  <span className="text-xs text-mu" data-testid="question-other-answer">
                    Boshqa: {answered.other}
                  </span>
                )
              )}
            </fieldset>
          );
        })}
        {canAct && (
          <div className="flex flex-wrap items-center justify-end gap-2">
            {qs.length > 1 && <span className="mr-auto text-xs text-mu">{done}/{qs.length} javoblandi</span>}
            <button type="button" className="btn btn-no" disabled={submitting || m.buttons.deny.disabled} onClick={onDeny} data-testid="deny">
              Rad etish
            </button>
            <button type="button" className="btn btn-ok" disabled={!canSubmit} onClick={() => answers && onSubmitAnswers?.(answers)} data-testid="submit-answers">
              Javob yuborish
            </button>
          </div>
        )}
        {m.message && (
          <span role={m.messageTone === "red" ? "alert" : undefined} className={`text-xs ${msgColor}`} data-testid="question-note">
            {m.message}
          </span>
        )}
      </div>
    </div>
  );
}

/** Ruxsat kartasi: faqat ko'rinish (props orqali; testlanadi). `a` / `d` tugmalari fokus ichida ishlaydi. */
export function ApprovalCardView(props: ApprovalCardViewProps) {
  if (props.approval.kind === "plan") return <PlanCardView {...props} />;
  if (props.approval.kind === "question") return <QuestionCardView {...props} />;
  return <ToolCardView {...props} />;
}

function ToolCardView({ approval: a, model: m, variant, machine, confirming, submitting, onAsk, onDeny, onConfirm, onCancelConfirm }: ApprovalCardViewProps) {
  const summary = toolSummary(a.toolInputRedacted);
  const timerColor = m.urgent ? "text-red" : m.active ? "text-tx" : "text-mu";
  const borderColor = m.active ? (m.urgent ? "border-red" : "border-org") : "border-bd";
  const msgColor = m.messageTone === "red" ? "text-red" : m.messageTone === "tx" ? "text-tx" : "text-mu";

  function onKeyDown(e: React.KeyboardEvent) {
    if (!m.showButtons || submitting || e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target as HTMLElement;
    if (t.tagName === "TEXTAREA" || t.tagName === "INPUT") return; // matn yozayotganda tugma qisqartmalari ishlamasin
    if (e.key === "a" && !m.buttons.allow.disabled && !confirming) {
      e.preventDefault();
      onAsk();
    } else if (e.key === "d" && !m.buttons.deny.disabled) {
      e.preventDefault();
      onDeny();
    }
  }

  const buttons = m.showButtons && !confirming && (
    <div className="flex gap-2">
      <button type="button" className="btn btn-no" disabled={m.buttons.deny.disabled} onClick={onDeny} aria-keyshortcuts="d" data-testid="deny">
        {m.buttons.deny.label} <span className="kbd">d</span>
      </button>
      <button type="button" className="btn btn-ok" disabled={m.buttons.allow.disabled} onClick={onAsk} aria-keyshortcuts="a" data-testid="allow">
        {m.buttons.allow.label} <span className="kbd">a</span>
      </button>
    </div>
  );

  const confirmPanel = confirming && (
    <div className="flex flex-wrap items-center gap-2 rounded-lg bg-yel-bg px-3 py-2.5" role="group" aria-label="Tasdiqlash">
      <span className="min-w-0 flex-1 text-tx">Bu masofaviy amal {machine} da bajariladi (audit yoziladi). Rostdan ruxsat berasizmi?</span>
      <button type="button" className="btn" onClick={onCancelConfirm} autoFocus>
        Bekor
      </button>
      <button type="button" className="btn btn-ok" onClick={onConfirm} disabled={submitting}>
        Ha, ruxsat berish
      </button>
    </div>
  );

  if (variant === "row") {
    return (
      <div
        tabIndex={0}
        onKeyDown={onKeyDown}
        data-testid="approval-card"
        data-kind={m.kind}
        aria-label={`${m.title}: ${a.projectName ?? "loyihasiz"}, ${a.toolName}`}
        className={`flex flex-wrap items-center gap-4 border-t border-bd px-4 py-3.5 outline-offset-[-2px] ${m.dim ? "opacity-70" : ""}`}
      >
        <div className="flex min-w-0 flex-[1_1_420px] flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`pill ${DOT_FG[m.tone]} ${HEAD_BG[m.tone]}`}>
              <span className={`dot ${m.active ? "live" : ""}`} />
              {m.kind === "pending" || m.kind === "confirm" ? "Ruxsat kutmoqda" : m.title}
            </span>
            <span className="font-semibold">{a.projectName ?? "(loyihasiz)"}</span>
            <span className="text-mu">·</span>
            <span className="mono text-mu">{machine}</span>
            <span className="pill mono bg-s3 text-tx">{a.toolName}</span>
            {a.autoRuleId !== null && <RuleBadge ruleId={a.autoRuleId} />}
          </div>
          <code className="mono block truncate rounded-md border border-bd bg-s2 px-2.5 py-2 text-xs" title={summary.detail}>
            {summary.headline}
          </code>
          <InputGuard detail={summary.detail} full />
        </div>
        <div className="flex w-[120px] flex-col gap-1.5">
          <span className={`mono text-[13px] font-semibold ${timerColor}`} suppressHydrationWarning>
            {m.timer}
          </span>
          {m.active && (
            <div className="h-1 rounded bg-s3">
              <div className="h-1 rounded" style={{ width: `${m.timerPct}%`, background: m.urgent ? "var(--red)" : "var(--tx)" }} />
            </div>
          )}
        </div>
        {buttons}
        {(m.message || confirming) && (
          <div className="flex basis-full flex-col gap-2">
            {confirmPanel}
            {m.message && !confirming && (
              <span role={m.messageTone === "red" ? "alert" : undefined} className={`text-xs ${msgColor}`}>
                {m.message}
              </span>
            )}
          </div>
        )}
        {confirming && !m.message && <div className="basis-full">{confirmPanel}</div>}
      </div>
    );
  }

  return (
    <div
      tabIndex={0}
      onKeyDown={onKeyDown}
      data-testid="approval-card"
      data-kind={m.kind}
      aria-label={`${m.title}: ${a.toolName}`}
      className={`card overflow-hidden ${borderColor}`}
    >
      <div className={`flex items-center gap-2 px-3.5 py-2.5 ${HEAD_BG[m.tone]}`}>
        <span className={`dot ${DOT_FG[m.tone]} ${m.active ? "live" : ""}`} />
        <span className="flex-1 font-semibold">{m.title}</span>
        <span className={`mono font-semibold ${timerColor}`} suppressHydrationWarning>
          {m.timer}
        </span>
      </div>
      <div className={`flex flex-col gap-2.5 px-3.5 py-3 ${m.dim ? "opacity-60" : ""}`}>
        <div className="flex items-center gap-2">
          <span className="pill mono bg-s3">{a.toolName}</span>
          {a.autoRuleId !== null && <RuleBadge ruleId={a.autoRuleId} />}
          <span className="mono truncate text-xs text-mu" title={a.cwd}>
            {a.cwd}
          </span>
        </div>
        <InputGuard detail={summary.detail} full={false} />
        <pre className="mono m-0 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md border border-bd bg-s2 px-3 py-2.5 text-xs">{summary.detail}</pre>
        {confirmPanel}
        {buttons && <div className="flex justify-end">{buttons}</div>}
        {m.message && !confirming && (
          <span role={m.messageTone === "red" ? "alert" : undefined} className={`text-xs ${msgColor}`}>
            {m.message}
          </span>
        )}
      </div>
    </div>
  );
}

/** Jonli ma'lumotga ulangan ruxsat kartasi: qaror yuboradi, lockdown/token holatini hisobga oladi. */
export function ApprovalCard({ approval, variant }: { approval: ApprovalDto; variant: "row" | "card" }) {
  const { lockdown, canApprove, machines, resolveApproval, refreshApprovals } = useLiveData();
  const now = useNow();
  const [submit, setSubmit] = useState<SubmitState>({ kind: "idle" });
  const [confirming, setConfirming] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [draft, setDraft] = useState<QuestionDraft>(() => emptyDraft(approval.questions ?? []));

  const names = machineNameMap(machines);
  const machine = names.get(approval.machineId) ?? shortSlug(approval.machineSlug);
  const model = approvalCardModel(approval, { now, lockdown, canApprove, submit, confirming });

  async function decide(behavior: ApprovalBehavior, message?: string, answers?: AskAnswer[]) {
    setSubmit({ kind: "submitting", behavior });
    setConfirming(false);
    try {
      const res = await postJson(`/approvals/${approval.id}/decision`, { behavior, ...(message ? { message: message.trim().slice(0, PLAN_FEEDBACK_MAX) } : {}), ...(answers ? { answers } : {}) }, ApprovalDecisionResponseSchema);
      setSubmit({ kind: "idle" });
      resolveApproval(res.approval);
    } catch (e) {
      const message = e instanceof ApiCallError ? mapDecisionError(e.status, e.body) : mapDecisionError(0, null);
      setSubmit({ kind: "error", message });
      if (e instanceof ApiCallError && (e.status === 409 || e.status === 404)) refreshApprovals();
    }
  }

  return (
    <ApprovalCardView
      approval={approval}
      model={model}
      variant={variant}
      machine={machine}
      confirming={confirming}
      submitting={submit.kind === "submitting"}
      onAsk={() => setConfirming(true)}
      onDeny={() => void decide("deny")}
      onConfirm={() => void decide("allow")}
      onCancelConfirm={() => setConfirming(false)}
      feedback={feedback}
      onFeedbackChange={setFeedback}
      onDenyFeedback={() => void decide("deny", feedback)}
      draft={draft}
      onDraftChange={setDraft}
      onSubmitAnswers={(answers) => void decide("allow", undefined, answers)}
    />
  );
}
