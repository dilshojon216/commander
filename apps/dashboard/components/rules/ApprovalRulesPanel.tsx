"use client";

import { CreateApprovalRuleResponseSchema, ListApprovalRulesResponseSchema } from "@commander/contracts";
import type { ApprovalRuleDto, RuleScope } from "@commander/contracts";
import { useCallback, useEffect, useState } from "react";
import { useLiveData } from "@/components/LiveData";
import { ApiCallError, getJson, postJson, requestJson } from "@/lib/client-api";
import { RULES_SAFETY_NOTE, RULE_DURATION_OPTIONS, RULE_TOOL_OPTIONS, SCOPE_LABEL, buildRuleBody, initialRuleForm, ruleErrorText, ruleRemaining, ruleSummary, rulesCollapsedSummary } from "@/lib/rules-ui";
import type { RuleDurationId, RuleFormState } from "@/lib/rules-ui";
import { useNow } from "@/lib/use-now";

export interface ApprovalRulesPanelViewProps {
  title: string;
  scope: RuleScope;
  rules: ApprovalRuleDto[] | null;
  loadError: string | null;
  now: number;
  form: RuleFormState;
  formError: string | null;
  canCreate: boolean;
  /** Yaratish o'chiq bo'lsa sababi (lockdown, token yo'q). */
  disabledHint: string | null;
  submitting: boolean;
  revokingId: number | null;
  onFormChange: (f: RuleFormState) => void;
  onCreate: () => void;
  onRevoke: (id: number) => void;
  /** Yig'iladigan rejim: sarlavha + bir qatorli xulosa; `open` bo'lmaguncha qoidalar va forma yashirin. */
  collapsible?: boolean;
  open?: boolean;
  onToggle?: () => void;
}

/** Avto-ruxsat qoidalari paneli: faqat ko'rinish (props orqali; testlanadi). */
export function ApprovalRulesPanelView(p: ApprovalRulesPanelViewProps) {
  const toggleTool = (id: string) => p.onFormChange({ ...p.form, tools: p.form.tools.includes(id) ? p.form.tools.filter((t) => t !== id) : [...p.form.tools, id] });
  const active = p.rules?.filter((r) => r.status === "active") ?? [];

  const collapsed = p.collapsible === true && p.open !== true;
  const summary = rulesCollapsedSummary(p.rules);

  return (
    <section aria-label="Avto-ruxsat qoidalari" className="flex flex-col gap-2.5" data-testid="rules-panel">
      {p.collapsible ? (
        <button type="button" className="flex w-full items-center gap-2 border-0 bg-transparent p-0 text-left" style={{ cursor: "pointer", font: "inherit", color: "inherit" }} aria-expanded={!collapsed} onClick={p.onToggle} data-testid="rules-toggle">
          <span className="lbl">{p.title}</span>
          <span className="text-xs text-mu" data-testid="rules-summary">
            {summary ?? (p.loadError ? "Yuklab bo'lmadi" : "Yuklanmoqda...")}
          </span>
          <span className="ml-auto text-xs text-mu" aria-hidden="true">
            {collapsed ? "Ochish ▾" : "Yig'ish ▴"}
          </span>
        </button>
      ) : (
        <span className="lbl">{p.title}</span>
      )}
      {!collapsed && <RulesBody p={p} active={active} toggleTool={toggleTool} />}
    </section>
  );
}

function RulesBody({ p, active, toggleTool }: { p: ApprovalRulesPanelViewProps; active: ApprovalRuleDto[]; toggleTool: (id: string) => void }) {
  return (
    <>

      {p.loadError && (
        <div role="alert" className="rounded-lg bg-red-bg px-3 py-2 text-xs text-red">
          {p.loadError}
        </div>
      )}

      {p.rules === null && !p.loadError && <span className="text-xs text-mu">Yuklanmoqda...</span>}
      {p.rules !== null && active.length === 0 && <span className="text-xs text-mu">Faol qoida yo&apos;q: har bir ruxsat qo&apos;lda tasdiqlanadi.</span>}

      {active.length > 0 && (
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {active.map((r) => (
            <li key={r.id} data-testid="rule-row" className="flex flex-col gap-1 rounded-lg border border-bd bg-s2 px-3 py-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="pill mono bg-s3">#{r.id}</span>
                <span className="pill bg-s3 text-mu">{SCOPE_LABEL[r.scope]}</span>
                <span className="mono text-xs text-mu" suppressHydrationWarning>
                  {ruleRemaining(r, p.now)}
                </span>
                <span className="ml-auto text-xs text-mu">{r.autoCount} marta ishladi</span>
                <button type="button" className="btn btn-no" disabled={p.revokingId === r.id} onClick={() => p.onRevoke(r.id)} data-testid="rule-revoke">
                  {p.revokingId === r.id ? "Bekor qilinmoqda..." : "Bekor qilish"}
                </button>
              </div>
              <span className="mono break-words text-xs">{ruleSummary(r)}</span>
            </li>
          ))}
        </ul>
      )}

      <form
        className="flex flex-col gap-2 rounded-lg border border-bd p-3"
        onSubmit={(e) => {
          e.preventDefault();
          p.onCreate();
        }}
        aria-label="Yangi qoida"
      >
        <fieldset className="m-0 flex flex-wrap gap-x-3 gap-y-1 border-0 p-0">
          <legend className="mb-1 p-0 text-xs text-mu">Vositalar</legend>
          {RULE_TOOL_OPTIONS.map((t) => (
            <label key={t.id} className="flex items-center gap-1.5 text-xs" title={t.hint}>
              <input type="checkbox" checked={p.form.tools.includes(t.id)} onChange={() => toggleTool(t.id)} disabled={!p.canCreate} />
              <span className="mono">{t.label}</span>
            </label>
          ))}
        </fieldset>
        <label className="flex flex-col gap-1 text-xs text-mu">
          Yo&apos;l andozalari (loyiha papkasiga nisbatan; vergul yoki yangi qator; bo&apos;sh = papka ichidagi hamma fayl)
          <input
            className="field mono"
            value={p.form.globsText}
            onChange={(e) => p.onFormChange({ ...p.form, globsText: e.target.value })}
            placeholder="src/**, docs/*.md"
            disabled={!p.canCreate}
            maxLength={1000}
            data-testid="rule-globs"
          />
        </label>
        <label className="flex items-center gap-2 text-xs text-mu">
          Muddat
          <select className="field" value={p.form.duration} onChange={(e) => p.onFormChange({ ...p.form, duration: e.target.value as RuleDurationId })} disabled={!p.canCreate} data-testid="rule-duration">
            {RULE_DURATION_OPTIONS.map((d) => (
              <option key={d.id} value={d.id}>
                {d.label}
              </option>
            ))}
          </select>
          <button type="submit" className="btn btn-ok ml-auto" disabled={!p.canCreate || p.submitting} data-testid="rule-create">
            {p.submitting ? "Yaratilmoqda..." : "Qoida yaratish"}
          </button>
        </label>
        {p.formError && (
          <div role="alert" className="text-xs text-red" data-testid="rule-error">
            {p.formError}
          </div>
        )}
        {p.disabledHint && <span className="text-xs text-mu">{p.disabledHint}</span>}
        <span className="text-[11px] text-fa">{RULES_SAFETY_NOTE}</span>
      </form>
    </>
  );
}

/** Jonli ma'lumotga ulangan qoidalar paneli (sessiya sahifasi: scope=session, loyiha ish maydoni: scope=project). */
export function ApprovalRulesPanel({ title, scope, scopeRef, collapsible = false }: { title: string; scope: RuleScope; scopeRef: string; collapsible?: boolean }) {
  const [open, setOpen] = useState(false);
  const { canControl, lockdown, approvals } = useLiveData();
  const now = useNow();
  const [rules, setRules] = useState<ApprovalRuleDto[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [form, setForm] = useState<RuleFormState>(initialRuleForm);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [revokingId, setRevokingId] = useState<number | null>(null);

  const load = useCallback(
    (signal?: AbortSignal) => {
      const qs = new URLSearchParams({ scope, scopeRef });
      getJson(`/approval-rules?${qs}`, ListApprovalRulesResponseSchema, signal)
        .then((r) => {
          setRules(r.rules);
          setLoadError(null);
        })
        .catch((e: unknown) => {
          if (signal?.aborted) return;
          setLoadError(e instanceof ApiCallError ? ruleErrorText(e.status, e.body) : ruleErrorText(0, null));
        });
    },
    [scope, scopeRef],
  );

  useEffect(() => {
    const ctl = new AbortController();
    load(ctl.signal);
    const t = setInterval(() => load(), 30_000);
    return () => {
      ctl.abort();
      clearInterval(t);
    };
  }, [load]);

  // Avto-ruxsat ishlaganda ("N marta ishladi") ro'yxat yangilansin: so'nggi hal qilingan ruxsatlar o'zgarganda.
  const lastResolvedId = approvals?.recent[0]?.id ?? null;
  useEffect(() => {
    if (lastResolvedId) load();
  }, [lastResolvedId, load]);

  async function create() {
    const built = buildRuleBody(scope, scopeRef, form);
    if (!built.ok) {
      setFormError(built.error);
      return;
    }
    setSubmitting(true);
    setFormError(null);
    try {
      await postJson("/approval-rules", built.body, CreateApprovalRuleResponseSchema);
      setForm(initialRuleForm());
      load();
    } catch (e) {
      setFormError(e instanceof ApiCallError ? ruleErrorText(e.status, e.body) : ruleErrorText(0, null));
    } finally {
      setSubmitting(false);
    }
  }

  async function revoke(id: number) {
    setRevokingId(id);
    setFormError(null);
    try {
      await requestJson("DELETE", `/approval-rules/${id}`);
      load();
    } catch (e) {
      setFormError(e instanceof ApiCallError ? ruleErrorText(e.status, e.body) : ruleErrorText(0, null));
    } finally {
      setRevokingId(null);
    }
  }

  const disabledHint = !canControl ? "COMMANDER_CONTROL_TOKEN sozlanmagan: qoida yaratib bo'lmaydi" : lockdown ? "Lockdown: yangi qoida yaratib bo'lmaydi (bekor qilish mumkin)" : null;
  return (
    <ApprovalRulesPanelView
      title={title}
      scope={scope}
      rules={rules}
      loadError={loadError}
      now={now}
      form={form}
      formError={formError}
      canCreate={canControl && !lockdown}
      disabledHint={disabledHint}
      submitting={submitting}
      revokingId={revokingId}
      onFormChange={setForm}
      onCreate={() => void create()}
      onRevoke={(id) => void revoke(id)}
      collapsible={collapsible}
      open={open}
      onToggle={() => setOpen((o) => !o)}
    />
  );
}
