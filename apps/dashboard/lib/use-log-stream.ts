"use client";

import { CreateCommandResponseSchema, LOG_LIMITS, LogsReadResponseSchema } from "@commander/contracts";
import type { LogsReadResponse, StartLogsBody } from "@commander/contracts";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { ApiCallError, getJson, postJson, requestJson } from "./client-api";
import { LOG_MAX_CONSECUTIVE_ERRORS, LOG_POLL_MS, backoffDelay, initialLogState, isStreamActive, logErrorText, logHttpErrorText, logReducer } from "./logs-view";
import type { LogViewState } from "./logs-view";

export interface LogStream {
  view: LogViewState;
  /** Boshlash so'rovi ketmoqda. */
  starting: boolean;
  /** O'qish halqasi ishlayapti (jonli yoki hali tugamagan). */
  running: boolean;
  /** Boshlashdagi rad/xato (buyruq xato kodi yoki HTTP) yoki o'qishdan voz kechilgani. */
  error: string | null;
  start: (body: StartLogsBody) => void;
  /** Foydalanuvchi to'xtatadi: o'qish to'xtaydi va serverga DELETE yuboriladi. */
  stop: () => void;
  clear: () => void;
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

/** Serverga to'xtatish xabari (xato muhim emas: markaz 30 s o'qilmasa o'zi to'xtatadi). */
function sendStop(commandId: string): void {
  requestJson("DELETE", `/logs/${commandId}`).catch(() => undefined);
}

/**
 * Log oqimi: boshlash (POST) -> kursor bilan o'qish (GET ?after=nextSeq).
 *  - so'rovlar HECH QACHON ustma-ust tushmaydi (ketma-ket halqa), oraliq 1 s (sahifa to'la bo'lsa darhol keyingisi);
 *  - xatoda eksponensial kutish (1, 2, 4, 8, 10 s), ketma-ket 6 xatodan keyin voz kechiladi;
 *  - unmount/qayta boshlash/to'xtatishda bekor qilinadi va DELETE yuboriladi.
 */
export function useLogStream(machineId: string): LogStream {
  const [view, dispatch] = useReducer(logReducer, initialLogState);
  const [starting, setStarting] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const runRef = useRef<{ ctl: AbortController; commandId: string | null } | null>(null);

  const halt = useCallback((notifyServer: boolean) => {
    const run = runRef.current;
    runRef.current = null;
    if (!run) return;
    run.ctl.abort();
    setRunning(false);
    if (notifyServer && run.commandId) sendStop(run.commandId);
  }, []);

  const poll = useCallback(async (run: { ctl: AbortController; commandId: string | null }, commandId: string) => {
    let errors = 0;
    let after = 0;
    while (!run.ctl.signal.aborted) {
      let res: LogsReadResponse | null = null;
      try {
        res = await getJson(`/logs/${commandId}?after=${after}`, LogsReadResponseSchema, run.ctl.signal);
        errors = 0;
      } catch (e) {
        if (run.ctl.signal.aborted) return;
        if (e instanceof ApiCallError && e.status === 404) {
          setError("Oqim topilmadi (muddati tugagan yoki markaz qayta ishga tushgan). Qayta boshlang.");
          return;
        }
        errors += 1;
        if (errors >= LOG_MAX_CONSECUTIVE_ERRORS) {
          setError("Markaz bilan aloqa uzildi: loglarni o'qish to'xtatildi. Qayta boshlang.");
          sendStop(commandId);
          return;
        }
      }
      if (res) {
        after = res.nextSeq;
        dispatch({ type: "read", response: res });
        if (!isStreamActive(res.state)) return;
        // Sahifa to'lgan bo'lsa yana qatorlar bor: qisqa pauza bilan darhol davom etamiz
        const delay = res.lines.length >= LOG_LIMITS.readPageLines ? 50 : LOG_POLL_MS;
        if (!(await sleep(delay, run.ctl.signal))) return;
      } else if (!(await sleep(backoffDelay(errors - 1), run.ctl.signal))) {
        return;
      }
    }
  }, []);

  const start = useCallback(
    (body: StartLogsBody) => {
      halt(true);
      dispatch({ type: "reset" });
      setError(null);
      const run: { ctl: AbortController; commandId: string | null } = { ctl: new AbortController(), commandId: null };
      runRef.current = run;
      setStarting(true);
      postJson(`/machines/${machineId}/logs`, body, CreateCommandResponseSchema, { "Idempotency-Key": crypto.randomUUID() })
        .then(async (r) => {
          if (run.ctl.signal.aborted) return;
          const c = r.command;
          if (c.status === "rejected" || c.status === "failed" || c.status === "expired") {
            setError(logErrorText(c.errorCode ?? (c.status === "expired" ? "dispatch_expired" : null), c.errorMessage));
            return;
          }
          run.commandId = c.id;
          setStarting(false);
          setRunning(true);
          await poll(run, c.id);
          if (runRef.current === run) setRunning(false);
        })
        .catch((e: unknown) => {
          if (run.ctl.signal.aborted) return;
          setError(e instanceof ApiCallError ? logHttpErrorText(e.status, e.body) : logHttpErrorText(0, null));
        })
        .finally(() => {
          if (runRef.current === run) setStarting(false);
        });
    },
    [machineId, halt, poll],
  );

  const stop = useCallback(() => halt(true), [halt]);
  const clear = useCallback(() => dispatch({ type: "clear" }), []);

  // Sahifadan/tabdan chiqishda: bekor qilish + serverga to'xtatish
  useEffect(() => () => halt(true), [halt]);

  return { view, starting, running, error, start, stop, clear };
}
