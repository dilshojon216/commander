"use client";

import { LOG_LIMITS, LogsReadResponseSchema } from "@commander/contracts";
import type { LogsReadResponse } from "@commander/contracts";
import { useEffect, useReducer, useRef, useState } from "react";
import { ApiCallError, getJson } from "./client-api";
import { LOG_MAX_CONSECUTIVE_ERRORS, LOG_POLL_MS, backoffDelay, initialLogState, isStreamActive, logReducer } from "./logs-view";
import type { LogViewState } from "./logs-view";

export interface DeployOutput {
  view: LogViewState;
  /** O'qish halqasi ishlayapti. */
  polling: boolean;
  /** Oqim topilmadi yoki aloqa uzildi (matn o'zbekcha). */
  error: string | null;
}

/** `ms` kutadi; `signal` bekor bo'lsa darhol `false`. */
function sleep(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve(false);
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      resolve(false);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Deploy chiqishi: `GET /deploy/runs/:commandId/output?after=<nextSeq>` (log ko'ruvchi bilan bir xil shakl va kursor).
 * `use-log-stream.ts` kabi: so'rovlar ketma-ket (ustma-ust tushmaydi), xatoda eksponensial kutish, ketma-ket 6 xatodan keyin voz
 * kechiladi; `state` done|error bo'lganda to'xtaydi. Tugagan buyruqda (`finished`) yangi qator kelmasa ham to'xtaydi.
 * Komponent `key={commandId}` bilan qayta yaratiladi (holat yangidan boshlanadi).
 */
export function useDeployOutput(commandId: string | null, enabled: boolean, finished: boolean): DeployOutput {
  const [view, dispatch] = useReducer(logReducer, initialLogState);
  const [polling, setPolling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // `finished` o'zgarganda halqa qayta boshlanmasligi uchun ref (qayta boshlansa kursor 0 ga qaytib qatorlar takrorlanardi)
  const finishedRef = useRef(finished);
  useEffect(() => {
    finishedRef.current = finished;
  }, [finished]);

  useEffect(() => {
    if (!commandId || !enabled) return;
    const ctl = new AbortController();
    void (async () => {
      setPolling(true);
      let errors = 0;
      let after = 0;
      let emptyAfterFinish = 0;
      while (!ctl.signal.aborted) {
        let res: LogsReadResponse | null = null;
        try {
          res = await getJson(`/deploy/runs/${commandId}/output?after=${after}`, LogsReadResponseSchema, ctl.signal);
          errors = 0;
        } catch (e) {
          if (ctl.signal.aborted) break;
          if (e instanceof ApiCallError && e.status === 404) {
            setError("Chiqish mavjud emas: u saqlanmaydi (muddati tugagan yoki markaz qayta ishga tushgan).");
            break;
          }
          errors += 1;
          if (errors >= LOG_MAX_CONSECUTIVE_ERRORS) {
            setError("Markaz bilan aloqa uzildi: chiqishni o'qish to'xtatildi.");
            break;
          }
        }
        if (res) {
          after = res.nextSeq;
          dispatch({ type: "read", response: res });
          if (!isStreamActive(res.state)) break;
          if (res.lines.length === 0 && finishedRef.current) {
            emptyAfterFinish += 1;
            if (emptyAfterFinish >= 2) break;
          }
          const delay = res.lines.length >= LOG_LIMITS.readPageLines ? 50 : LOG_POLL_MS;
          if (!(await sleep(delay, ctl.signal))) break;
        } else if (!(await sleep(backoffDelay(errors - 1), ctl.signal))) {
          break;
        }
      }
      if (!ctl.signal.aborted) setPolling(false);
    })();
    return () => ctl.abort();
  }, [commandId, enabled]);

  return { view, polling, error };
}
