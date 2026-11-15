"use client";

import type { BudgetStatus } from "@commander/contracts";
import Link from "next/link";
import { BUDGET_BAR_TONE, BUDGET_STATE_LABEL, BUDGET_TEXT_TONE, budgetBarView, resetCountdown } from "@/lib/budgets-view";

/** Bitta byudjet chizig'i: sarf/chegara, foiz, holat (yashil/sariq/qizil), yangilanish vaqti. */
export function BudgetBar({ status, label, resetsAt, now }: { status: BudgetStatus; label?: string; resetsAt?: string; now?: number }) {
  const v = budgetBarView(status);
  const reset = resetsAt && now ? resetCountdown(resetsAt, now) : "";
  return (
    <div className="flex flex-col gap-1.5" data-testid="budget-bar" data-state={v.state}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-xs font-medium">{label ?? status.label}</span>
        <span className={`mono text-xs ${BUDGET_TEXT_TONE[v.state]}`}>
          {v.usageText} · {v.pctText}
        </span>
      </div>
      <div className="h-1.5 rounded bg-s3" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(v.widthPct)} aria-label={`Kunlik byudjet: ${v.pctText}`}>
        <div className={`h-1.5 rounded ${BUDGET_BAR_TONE[v.state]}`} style={{ width: `${v.widthPct}%` }} data-testid="budget-fill" />
      </div>
      <div className="flex flex-wrap gap-2 text-[11px] text-mu">
        <span className={BUDGET_TEXT_TONE[v.state]}>{BUDGET_STATE_LABEL[v.state]}</span>
        {v.extraText ? <span>{v.extraText}</span> : null}
        {reset ? <span suppressHydrationWarning>yangilanishgacha {reset}</span> : null}
        {status.autoStop ? <span>avto-to&apos;xtatish yoqiq</span> : null}
      </div>
    </div>
  );
}

/** Kartochka: sarlavha + chiziqlar (bo'sh bo'lsa hech narsa chiqmaydi) + sozlamaga havola. */
export function BudgetCard({ title, items, resetsAt, now }: { title: string; items: BudgetStatus[]; resetsAt?: string; now?: number }) {
  return (
    <section className="card flex flex-col gap-3 p-4" aria-label={title} data-testid="budget-card">
      <div className="flex items-center justify-between">
        <h2 className="m-0 text-sm font-semibold">{title}</h2>
        <Link href="/budgets" className="text-xs">
          Sozlash →
        </Link>
      </div>
      {items.length === 0 ? <span className="text-xs text-mu">Byudjet belgilanmagan.</span> : items.map((s) => <BudgetBar key={`${s.scopeKind}:${s.scopeKey}`} status={s} resetsAt={resetsAt} now={now} />)}
    </section>
  );
}
