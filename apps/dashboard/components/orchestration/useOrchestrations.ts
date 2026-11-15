"use client";

import { CancelOrchestrationResponseSchema, ListOrchestrationsResponseSchema, OrchestrationDtoSchema, OrchestrationUpdatedMessageSchema } from "@commander/contracts";
import type { OrchestrationDto } from "@commander/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiCallError, getJson, postJson } from "@/lib/client-api";
import { useLive } from "@/lib/live-client";
import { orchHttpErrorText, sortOrchestrations } from "@/lib/orchestration-view";
import { upsertById } from "@/lib/push";

const POLL_MS = 30_000;

type Done = { ok: true; orchestration: OrchestrationDto } | { ok: false; error: string };

/** Loyiha guruhidagi orkestratsiyalar: REST snapshot + `orchestration.updated` push (kanal `orchestrations`) + 30 s himoya so'rovi. */
export function useOrchestrations(projectId: string): {
  items: OrchestrationDto[];
  loaded: boolean;
  error: string | null;
  create: (body: Record<string, unknown>) => Promise<Done>;
  cancel: (id: string) => Promise<string | null>;
  reload: () => void;
} {
  const [items, setItems] = useState<OrchestrationDto[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const aborter = useRef<AbortController | null>(null);
  const known = useRef(new Set<string>());

  const load = useCallback(() => {
    aborter.current?.abort();
    const ctl = new AbortController();
    aborter.current = ctl;
    getJson(`/orchestrations?projectId=${projectId}&limit=30`, ListOrchestrationsResponseSchema, ctl.signal)
      .then((r) => {
        known.current = new Set(r.items.map((i) => i.groupKey));
        setItems(sortOrchestrations(r.items));
        setLoaded(true);
        setError(null);
      })
      .catch((e: unknown) => {
        if (!ctl.signal.aborted) setError(e instanceof Error ? e.message : "Xatolik");
      });
  }, [projectId]);

  useEffect(() => {
    load();
    const t = setInterval(load, POLL_MS);
    return () => {
      aborter.current?.abort();
      clearInterval(t);
    };
  }, [load]);

  useLive((type, payload) => {
    if (type !== "orchestration.updated") return;
    const r = OrchestrationUpdatedMessageSchema.shape.payload.safeParse(payload);
    if (!r.success) return;
    const o = r.data.orchestration;
    if (known.current.has(o.groupKey) || o.projectId === projectId) setItems((l) => sortOrchestrations(upsertById(l, o)));
    else load(); // yangi guruh: ro'yxatni qayta o'qish (loyiha shu guruhga kirishi mumkin)
  }, load);

  const create = useCallback(async (body: Record<string, unknown>): Promise<Done> => {
    try {
      const o = await postJson("/orchestrations", body, OrchestrationDtoSchema);
      setItems((l) => sortOrchestrations(upsertById(l, o)));
      return { ok: true, orchestration: o };
    } catch (e) {
      return { ok: false, error: e instanceof ApiCallError ? orchHttpErrorText(e.status, e.body) : orchHttpErrorText(0, null) };
    }
  }, []);

  const cancel = useCallback(async (id: string): Promise<string | null> => {
    try {
      const r = await postJson(`/orchestrations/${id}/cancel`, {}, CancelOrchestrationResponseSchema);
      setItems((l) => sortOrchestrations(upsertById(l, r.orchestration)));
      return r.stopFailed > 0 ? `${r.stopped} ta sessiya to'xtatildi, ${r.stopFailed} tasini to'xtatib bo'lmadi (terminal sessiya yoki oflayn)` : null;
    } catch (e) {
      return e instanceof ApiCallError ? orchHttpErrorText(e.status, e.body) : orchHttpErrorText(0, null);
    }
  }, []);

  return { items, loaded, error, create, cancel, reload: load };
}
