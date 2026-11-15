"use client";

import { useSyncExternalStore } from "react";

/** Umumiy soat: hamma komponentlar bitta interval'dan foydalanadi. SSR'da 0 (placeholder ko'rsatiladi). */
let current = 0;
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  current = Date.now();
  if (!timer) {
    timer = setInterval(() => {
      current = Date.now();
      for (const l of listeners) l();
    }, 1000);
  }
  return () => {
    listeners.delete(cb);
    if (listeners.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

/** 0 = hali hydrate bo'lmagan. */
export function useNow(): number {
  return useSyncExternalStore(subscribe, () => current || (current = Date.now()), () => 0);
}
