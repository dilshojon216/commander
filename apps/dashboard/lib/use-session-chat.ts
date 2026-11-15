"use client";

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { SessionChat } from "./chat-types";
import { INITIAL_STORE, buildView, changedFiles, chatReducer } from "./chat-map";
import type { ChatAction } from "./chat-map";

const RETRY_MS = 3000;
const MAX_RETRIES = 20;

function newCid(): string {
  return globalThis.crypto.randomUUID();
}

/**
 * Sessiya chat oqimi: `/api/chat/[sessionId]/stream` (SSE, token serverda) ga ulanadi.
 * Kontrakt: `{items, state, code, hasOlder, loadingOlder, loadOlder}`.
 *  - items: eng eskisi birinchi `ChatItem[]` (lib/chat-types.ts), thinking ko'rsatilmaydi;
 *  - state: 'connecting' | 'live' | 'offline' | 'unavailable' | 'error'.
 */
export function useSessionChat(sessionId: string): SessionChat {
  const [store, dispatch] = useReducer(chatReducer, INITIAL_STORE);
  const cidRef = useRef<string>("");
  const cursorRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    cursorRef.current = store.cursor;
  }, [store.cursor]);

  // Yangi ochilgan sessiyada transcript fayli hali yaratilmagan bo'lishi mumkin (agent `not_found` beradi):
  // 'unavailable'/'error' holatida 3 s dan keyin qayta ulanamiz (cheklangan marta)
  const [retry, setRetry] = useState<{ sessionId: string; n: number }>({ sessionId, n: 0 });
  const attempt = retry.sessionId === sessionId ? retry.n : 0;

  useEffect(() => {
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const cid = newCid();
    cidRef.current = cid;
    dispatch({ type: "reset" });
    const es = new EventSource(`/api/chat/${sessionId}/stream?cid=${cid}`);
    es.onerror = () => dispatch({ type: "link-down" });
    es.addEventListener("chat", (ev) => {
      let msg: unknown;
      try {
        msg = JSON.parse((ev as MessageEvent<string>).data);
      } catch {
        return;
      }
      if (typeof msg !== "object" || msg === null) return;
      const m = msg as { kind?: string; payload?: unknown; state?: string; code?: string; error?: string | null };
      if (m.kind === "items" && m.payload && typeof m.payload === "object") {
        dispatch({ type: "items", payload: m.payload as Extract<ChatAction, { type: "items" }>["payload"] });
      } else if (m.kind === "state" && typeof m.state === "string") {
        dispatch({ type: "state", state: m.state as never, code: m.code as never });
        if ((m.state === "unavailable" || m.state === "error") && attempt < MAX_RETRIES && retryTimer === undefined) {
          retryTimer = setTimeout(() => setRetry({ sessionId, n: attempt + 1 }), RETRY_MS);
        }
      } else if (m.kind === "bridge" && m.error) {
        dispatch({ type: "link-down" });
      }
    });
    return () => {
      if (retryTimer !== undefined) clearTimeout(retryTimer);
      es.close();
    };
  }, [sessionId, attempt]);

  const loadOlder = useCallback(() => {
    const before = cursorRef.current;
    if (!before) return;
    dispatch({ type: "loading-older", value: true });
    fetch(`/api/chat/${sessionId}/older?cid=${cidRef.current}&before=${encodeURIComponent(before)}`, { cache: "no-store" })
      .then((r) => {
        if (!r.ok) dispatch({ type: "loading-older", value: false });
      })
      .catch(() => dispatch({ type: "loading-older", value: false }));
  }, [sessionId]);

  const items = useMemo(() => buildView(store.raw), [store.raw]);
  const files = useMemo(() => changedFiles(store.raw), [store.raw]);
  return { items, state: store.state, code: store.code, hasOlder: typeof store.cursor === "string", loadingOlder: store.loadingOlder, loadOlder, changedFiles: files };
}
