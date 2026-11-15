"use client";

import { PaceSettingsResponseSchema, StepUpExemptionResponseSchema } from "@commander/contracts";
import type { PaceOverrideBody, PaceSettingsResponse, PutPaceSettingsBody, StepUpExemptionResponse } from "@commander/contracts";
import { useCallback, useEffect, useState } from "react";
import { getJson, requestJson } from "./client-api";

interface Loaded<T> {
  data: T | null;
  error: string | null;
  /** Yozuvdan keyingi javobni to'g'ridan-to'g'ri qo'yish. */
  set: (v: T) => void;
  reload: () => void;
}

function useLoaded<T>(load: (signal: AbortSignal) => Promise<T>, failText: string): Loaded<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const ctl = new AbortController();
    load(ctl.signal)
      .then((r) => {
        setData(r);
        setError(null);
      })
      .catch((e: unknown) => {
        if (!ctl.signal.aborted) setError(e instanceof Error ? e.message : failText);
      });
    return () => ctl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick]);
  const reload = useCallback(() => setTick((n) => n + 1), []);
  return { data, error, set: setData, reload };
}

/** Haftalik limit tezligi sozlamalari (6.12). */
export function usePaceSettings(): Loaded<PaceSettingsResponse> {
  return useLoaded((s) => getJson("/limits/pace-settings", PaceSettingsResponseSchema, s), "Haftalik tezlik sozlamalarini olib bo'lmadi");
}

export async function putPaceSettings(body: PutPaceSettingsBody): Promise<PaceSettingsResponse> {
  return PaceSettingsResponseSchema.parse(await requestJson("PUT", "/limits/pace-settings", body));
}

/** "Bugun uchun ruxsat" (`reset: true` = bekor qilish). */
export async function overridePace(body: PaceOverrideBody): Promise<PaceSettingsResponse> {
  return PaceSettingsResponseSchema.parse(await requestJson("POST", "/limits/pace-override", body));
}

/** Telegram step-up istisnosi (6.17b). */
export function useStepUpExemption(): Loaded<StepUpExemptionResponse> {
  return useLoaded((s) => getJson("/settings/stepup-exemption", StepUpExemptionResponseSchema, s), "Telegram tasdig'i sozlamasini olib bo'lmadi");
}

export async function putStepUpExemption(exempt: boolean): Promise<StepUpExemptionResponse> {
  return StepUpExemptionResponseSchema.parse(await requestJson("PUT", "/settings/stepup-exemption", { exempt }));
}
