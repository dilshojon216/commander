"use client";

import { HealthSummaryResponseSchema, MachineHealthResponseSchema, MachineHealthUpdatedMessageSchema } from "@commander/contracts";
import type { HealthRange, HealthSummaryResponse, MachineHealthResponse } from "@commander/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { getJson } from "./client-api";
import { applyHealthPush } from "./health-view";
import type { HealthLive } from "./health-view";
import { useLive } from "./live-client";

const REFRESH_MS = 60_000;

/** Barcha mashinalar holati: `/health/summary` snapshot + `machine.health` push (kanal `health`). */
export function useHealthSummary(): { summary: HealthSummaryResponse | null; live: Record<string, HealthLive>; error: string | null } {
  const [summary, setSummary] = useState<HealthSummaryResponse | null>(null);
  const [live, setLive] = useState<Record<string, HealthLive>>({});
  const [error, setError] = useState<string | null>(null);

  const load = useCallback((signal?: AbortSignal) => {
    getJson("/health/summary", HealthSummaryResponseSchema, signal)
      .then((s) => {
        setSummary(s);
        setError(null);
      })
      .catch((e: unknown) => {
        if (signal?.aborted) return;
        setError(e instanceof Error ? e.message : "Xatolik");
      });
  }, []);

  useEffect(() => {
    const ctl = new AbortController();
    load(ctl.signal);
    const t = setInterval(() => load(), REFRESH_MS);
    return () => {
      ctl.abort();
      clearInterval(t);
    };
  }, [load]);

  useLive(
    (type, payload) => {
      if (type !== "machine.health") return;
      const r = MachineHealthUpdatedMessageSchema.shape.payload.safeParse(payload);
      if (!r.success) return;
      setLive((m) => applyHealthPush(m, r.data.machineId, { status: r.data.status, snapshot: r.data.snapshot, receivedAt: r.data.receivedAt }));
    },
    () => load(),
  );
  return { summary, live, error };
}

/** Bitta mashina: REST (grafik + hodisalar) + jonli `latest`. */
export function useMachineHealth(machineId: string, range: HealthRange): { data: MachineHealthResponse | null; live: HealthLive | null; error: string | null; reload: () => void } {
  const [data, setData] = useState<MachineHealthResponse | null>(null);
  const [live, setLive] = useState<HealthLive | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ctlRef = useRef<AbortController | null>(null);

  const load = useCallback(() => {
    ctlRef.current?.abort();
    const ctl = new AbortController();
    ctlRef.current = ctl;
    getJson(`/machines/${machineId}/health?range=${range}`, MachineHealthResponseSchema, ctl.signal)
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e: unknown) => {
        if (ctl.signal.aborted) return;
        setError(e instanceof Error ? e.message : "Xatolik");
      });
  }, [machineId, range]);

  useEffect(() => {
    load();
    const t = setInterval(load, REFRESH_MS * 5);
    return () => {
      ctlRef.current?.abort();
      clearInterval(t);
    };
  }, [load]);

  useLive(
    (type, payload) => {
      if (type !== "machine.health") return;
      const r = MachineHealthUpdatedMessageSchema.shape.payload.safeParse(payload);
      if (!r.success || r.data.machineId !== machineId) return;
      setLive((cur) => (cur && Date.parse(cur.receivedAt) > Date.parse(r.data.receivedAt) ? cur : { status: r.data.status, snapshot: r.data.snapshot, receivedAt: r.data.receivedAt }));
    },
    () => load(),
  );
  return { data, live, error, reload: load };
}
