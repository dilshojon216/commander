"use client";

import { useCallback, useEffect, useRef } from "react";
import { useLive } from "./live-client";
import { parsePush } from "./push";
import type { PushEvent } from "./push";

/**
 * Snapshot + push sinxronizatsiyasi. Resync paytida kelgan push'lar navbatga olinadi va
 * snapshot qo'llangandan KEYIN qayta o'ynaladi (eski snapshot yangi push'ni bosib ketmasin).
 */
export function useLiveSync<T>(opts: {
  fetchSnapshot: (signal: AbortSignal) => Promise<T>;
  onSnapshot: (data: T) => void;
  onError: (message: string | null) => void;
  onPush: (e: PushEvent) => void;
}): void {
  const loading = useRef(false);
  const queue = useRef<PushEvent[]>([]);
  const abort = useRef<AbortController | null>(null);
  const optsRef = useRef(opts);
  useEffect(() => {
    optsRef.current = opts;
  });

  const onPush = useCallback((type: string, payload: unknown) => {
    const e = parsePush(type, payload);
    if (!e) return;
    if (loading.current) queue.current.push(e);
    else optsRef.current.onPush(e);
  }, []);

  const onResync = useCallback(() => {
    abort.current?.abort();
    const ctl = new AbortController();
    abort.current = ctl;
    loading.current = true;
    queue.current = [];
    optsRef.current
      .fetchSnapshot(ctl.signal)
      .then((data) => {
        if (ctl.signal.aborted) return;
        optsRef.current.onSnapshot(data);
        optsRef.current.onError(null);
      })
      .catch((e: unknown) => {
        if (ctl.signal.aborted) return;
        optsRef.current.onError(e instanceof Error ? e.message : "Xatolik");
      })
      .finally(() => {
        if (ctl.signal.aborted) return;
        loading.current = false;
        const q = queue.current;
        queue.current = [];
        for (const e of q) optsRef.current.onPush(e);
      });
  }, []);

  useLive(onPush, onResync);
}
