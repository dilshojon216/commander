"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";
import type { LockdownState } from "./live-types";

/**
 * Brauzer tomondagi SSE menejeri: bitta EventSource (`/api/stream`) hamma komponentlar uchun.
 * `onResync` har safar ko'prik "ready" bo'lganda (birinchi ulanish va qayta ulanish) chaqiriladi:
 * shunda avval obuna, KEYIN REST snapshot tartibi saqlanadi.
 */

export interface LiveSnapshot {
  /** Brauzer <-> dashboard SSE ochiq. */
  sse: boolean;
  /** Dashboard <-> center ko'prigi obunada. */
  ready: boolean;
  lockdown: LockdownState | null;
  error: string | null;
}

type PushHandler = (type: string, payload: unknown) => void;

const pushHandlers = new Set<PushHandler>();
const resyncHandlers = new Set<() => void>();
const stateListeners = new Set<() => void>();
let source: EventSource | null = null;
let snapshot: LiveSnapshot = { sse: false, ready: false, lockdown: null, error: null };
const SERVER_SNAPSHOT: LiveSnapshot = snapshot;

function setSnapshot(next: Partial<LiveSnapshot>): void {
  snapshot = { ...snapshot, ...next };
  for (const l of stateListeners) l();
}

function parse(data: string): unknown {
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

function open(): void {
  if (source) return;
  const es = new EventSource("/api/stream");
  source = es;
  es.onopen = () => setSnapshot({ sse: true });
  es.onerror = () => setSnapshot({ sse: false, ready: false });
  es.addEventListener("bridge", (ev) => {
    const d = parse((ev as MessageEvent<string>).data) as { ready?: boolean; lockdown?: LockdownState | null; error?: string | null } | null;
    if (!d) return;
    const wasReady = snapshot.ready;
    setSnapshot({ sse: true, ready: d.ready === true, lockdown: d.lockdown ?? snapshot.lockdown, error: d.error ?? null });
    if (d.ready === true && !wasReady) for (const r of resyncHandlers) r();
  });
  es.addEventListener("push", (ev) => {
    const d = parse((ev as MessageEvent<string>).data) as { type?: string; payload?: unknown } | null;
    if (!d || typeof d.type !== "string") return;
    if (d.type === "lockdown.updated") return;
    for (const h of pushHandlers) h(d.type, d.payload);
  });
}

function closeIfUnused(): void {
  if (pushHandlers.size === 0 && resyncHandlers.size === 0 && stateListeners.size === 0 && source) {
    source.close();
    source = null;
    snapshot = { sse: false, ready: false, lockdown: snapshot.lockdown, error: null };
  }
}

function subscribeState(cb: () => void): () => void {
  stateListeners.add(cb);
  open();
  return () => {
    stateListeners.delete(cb);
    // keyingi tick'da: komponentlar almashganda ulanish uzilmasin
    setTimeout(closeIfUnused, 2000);
  };
}

export function useLiveState(): LiveSnapshot {
  return useSyncExternalStore(subscribeState, () => snapshot, () => SERVER_SNAPSHOT);
}

/**
 * Push'larni tinglash + resync. `onPush` va `onResync` ref orqali yangilanadi (qayta obuna bo'lmaydi).
 * Resync davomida kelgan push'lar `onPush`ga to'g'ridan-to'g'ri uzatiladi: snapshot tugagach
 * komponent o'z navbatini boshqaradi (qarang `useLiveCollection`).
 */
export function useLive(onPush: PushHandler, onResync: () => void): void {
  const pushRef = useRef(onPush);
  const resyncRef = useRef(onResync);
  useEffect(() => {
    pushRef.current = onPush;
    resyncRef.current = onResync;
  });
  useEffect(() => {
    const p: PushHandler = (t, pl) => pushRef.current(t, pl);
    const r = () => resyncRef.current();
    pushHandlers.add(p);
    resyncHandlers.add(r);
    open();
    // Bridge allaqachon tayyor bo'lsa (boshqa komponent ochgan): bir marta resync
    if (snapshot.ready) queueMicrotask(r);
    return () => {
      pushHandlers.delete(p);
      resyncHandlers.delete(r);
      setTimeout(closeIfUnused, 2000);
    };
  }, []);
}
