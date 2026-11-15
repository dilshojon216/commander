"use client";

import { InvestigateResponseSchema, InvestigationSettingsSchema, ListInvestigationsResponseSchema } from "@commander/contracts";
import type { InvestigateResponse, InvestigationDto, InvestigationSettings, InvestigationSubjectKind, PutInvestigationSettingsBody } from "@commander/contracts";
import { useCallback, useEffect, useState } from "react";
import { getJson, postJson, requestJson } from "./client-api";
import { INVESTIGATION_REFRESH_MS, hasActiveInvestigation } from "./investigation-view";

export interface InvestigationsQuery {
  machineId?: string;
  kind?: InvestigationSubjectKind;
}

/** Tekshiruvlar ro'yxati: bir marta o'qiladi; faqat FAOL tekshiruv bor ekan ~10 s da yangilanadi. */
export function useInvestigations(q: InvestigationsQuery): { items: InvestigationDto[]; reload: () => void; error: string | null } {
  const [items, setItems] = useState<InvestigationDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const qs = new URLSearchParams({ limit: "50" });
  if (q.machineId) qs.set("machineId", q.machineId);
  if (q.kind) qs.set("kind", q.kind);
  const query = qs.toString();

  useEffect(() => {
    const ctl = new AbortController();
    getJson(`/investigations?${query}`, ListInvestigationsResponseSchema, ctl.signal)
      .then((r) => {
        setItems(r.items);
        setError(null);
      })
      .catch((e: unknown) => {
        if (!ctl.signal.aborted) setError(e instanceof Error ? e.message : "Tekshiruvlarni olib bo'lmadi");
      });
    return () => ctl.abort();
  }, [query, tick]);

  const active = hasActiveInvestigation(items);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setTick((n) => n + 1), INVESTIGATION_REFRESH_MS);
    return () => clearInterval(t);
  }, [active]);

  const reload = useCallback(() => setTick((n) => n + 1), []);
  return { items, reload, error };
}

/** `POST /investigations`: HTTP xato `ApiCallError` bo'lib otiladi. */
export function startInvestigation(kind: InvestigationSubjectKind, id: string): Promise<InvestigateResponse> {
  return postJson("/investigations", { kind, id }, InvestigateResponseSchema);
}

export function fetchInvestigationSettings(signal?: AbortSignal): Promise<InvestigationSettings> {
  return getJson("/investigations/settings", InvestigationSettingsSchema, signal);
}

export function saveInvestigationSettings(body: PutInvestigationSettingsBody): Promise<unknown> {
  return requestJson("PUT", "/investigations/settings", body);
}
