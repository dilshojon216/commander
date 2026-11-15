"use client";

import { PutScanSettingsBodySchema, RunScanResponseSchema, ScanDetailSchema, ScanListResponseSchema, ScanSettingsSchema } from "@commander/contracts";
import type { PutScanSettingsBody, RunScanResponse, ScanDetail, ScanListResponse, ScanSettings } from "@commander/contracts";
import { useCallback, useEffect, useState } from "react";
import { getJson, postJson, requestJson } from "./client-api";

/** Skan holati kutilganda ro'yxat shuncha ms da yangilanadi. */
export const SCAN_REFRESH_MS = 8_000;

/** Xavfsizlik ro'yxati: bir marta o'qiladi; `watch` ekan (skan boshlangan) qisqa vaqt yangilanadi. */
export function useScans(watch: boolean): { data: ScanListResponse | null; error: string | null; reload: () => void } {
  const [data, setData] = useState<ScanListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const ctl = new AbortController();
    getJson("/scans", ScanListResponseSchema, ctl.signal)
      .then((r) => {
        setData(r);
        setError(null);
      })
      .catch((e: unknown) => {
        if (!ctl.signal.aborted) setError(e instanceof Error ? e.message : "Tekshiruvlarni olib bo'lmadi");
      });
    return () => ctl.abort();
  }, [tick]);
  useEffect(() => {
    if (!watch) return;
    const t = setInterval(() => setTick((n) => n + 1), SCAN_REFRESH_MS);
    return () => clearInterval(t);
  }, [watch]);
  const reload = useCallback(() => setTick((n) => n + 1), []);
  return { data, error, reload };
}

export function useScanDetail(scanId: string): { data: ScanDetail | null; error: string | null } {
  const [data, setData] = useState<ScanDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const ctl = new AbortController();
    getJson(`/scans/${scanId}`, ScanDetailSchema, ctl.signal)
      .then(setData)
      .catch((e: unknown) => {
        if (!ctl.signal.aborted) setError(e instanceof Error ? e.message : "Natijani olib bo'lmadi");
      });
    return () => ctl.abort();
  }, [scanId]);
  return { data, error };
}

/** `POST /projects/:id/scan` (faqat o'qiydigan buyruq). Xato `ApiCallError`. */
export function runScan(projectId: string): Promise<RunScanResponse> {
  return postJson(`/projects/${projectId}/scan`, {}, RunScanResponseSchema);
}

export function saveScanSettings(body: PutScanSettingsBody): Promise<unknown> {
  return requestJson("PUT", "/scan-settings", PutScanSettingsBodySchema.parse(body));
}

export function fetchScanSettings(signal?: AbortSignal): Promise<ScanSettings> {
  return getJson("/scan-settings", ScanSettingsSchema, signal);
}
