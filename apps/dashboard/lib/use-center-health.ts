"use client";

import { CenterHealthResponseSchema } from "@commander/contracts";
import type { CenterHealthResponse } from "@commander/contracts";
import { useEffect, useState } from "react";
import { getJson } from "./client-api";

const REFRESH_MS = 30_000;

/** Markaz o'z holati (5.5): `/center/health` (center har 60 s o'lchaydi), 30 s'da bir so'raladi. */
export function useCenterHealth(): { health: CenterHealthResponse | null; error: string | null } {
  const [health, setHealth] = useState<CenterHealthResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const ctl = new AbortController();
    const load = (): void => {
      getJson("/center/health", CenterHealthResponseSchema, ctl.signal)
        .then((h) => {
          setHealth(h);
          setError(null);
        })
        .catch((e: unknown) => {
          if (ctl.signal.aborted) return;
          setError(e instanceof Error ? e.message : "Xatolik");
        });
    };
    load();
    const t = setInterval(load, REFRESH_MS);
    return () => {
      ctl.abort();
      clearInterval(t);
    };
  }, []);
  return { health, error };
}
