"use client";

import { BudgetsResponseSchema } from "@commander/contracts";
import type { BudgetOverrideBody, BudgetsResponse, PutBudgetBody } from "@commander/contracts";
import { useCallback, useEffect, useState } from "react";
import { getJson, requestJson } from "./client-api";

export const BUDGET_REFRESH_MS = 60_000;

/** Byudjetlar va bugungi sarf: har daqiqada yangilanadi. */
export function useBudgets(): { data: BudgetsResponse | null; error: string | null; reload: () => void } {
  const [data, setData] = useState<BudgetsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const ctl = new AbortController();
    getJson("/budgets", BudgetsResponseSchema, ctl.signal)
      .then((r) => {
        setData(r);
        setError(null);
      })
      .catch((e: unknown) => {
        if (!ctl.signal.aborted) setError(e instanceof Error ? e.message : "Byudjetlarni olib bo'lmadi");
      });
    return () => ctl.abort();
  }, [tick]);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), BUDGET_REFRESH_MS);
    return () => clearInterval(t);
  }, []);
  const reload = useCallback(() => setTick((n) => n + 1), []);
  return { data, error, reload };
}

export function putBudget(body: PutBudgetBody): Promise<unknown> {
  return requestJson("PUT", "/budgets", body);
}

export function overrideBudget(body: BudgetOverrideBody): Promise<unknown> {
  return requestJson("POST", "/budgets/override", body);
}
