"use client";

import { ListQueueResponseSchema, QueueItemDtoSchema, QueueUpdatedMessageSchema } from "@commander/contracts";
import type { CreateQueueItemBody, QueueItemDto, UpdateQueueItemBody } from "@commander/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiCallError, getJson, patchJson, postJson, requestJson } from "@/lib/client-api";
import { useLive } from "@/lib/live-client";
import { upsertById } from "@/lib/push";
import { queueHttpErrorText } from "@/lib/queue-view";

const POLL_MS = 30_000;

/** Navbat ro'yxati: REST snapshot + `queue.updated` push (kanal `queue`) + 30 s himoya so'rovi. Amallar xatosi o'zbekcha matn. */
export function useQueue(): {
  items: QueueItemDto[];
  loaded: boolean;
  error: string | null;
  create: (body: CreateQueueItemBody) => Promise<{ ok: true } | { ok: false; error: string }>;
  update: (id: string, body: UpdateQueueItemBody) => Promise<{ ok: true } | { ok: false; error: string }>;
  runNow: (id: string) => Promise<string | null>;
  cancel: (id: string) => Promise<string | null>;
  remove: (id: string) => Promise<string | null>;
  reload: () => void;
} {
  const [items, setItems] = useState<QueueItemDto[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const aborter = useRef<AbortController | null>(null);

  const load = useCallback(() => {
    aborter.current?.abort();
    const ctl = new AbortController();
    aborter.current = ctl;
    getJson("/queue?limit=200", ListQueueResponseSchema, ctl.signal)
      .then((r) => {
        setItems(r.items);
        setLoaded(true);
        setError(null);
      })
      .catch((e: unknown) => {
        if (!ctl.signal.aborted) setError(e instanceof Error ? e.message : "Xatolik");
      });
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, POLL_MS);
    return () => {
      aborter.current?.abort();
      clearInterval(t);
    };
  }, [load]);

  useLive(
    (type, payload) => {
      if (type !== "queue.updated") return;
      const r = QueueUpdatedMessageSchema.shape.payload.safeParse(payload);
      if (r.success) setItems((l) => upsertById(l, r.data.item));
    },
    load,
  );

  const fail = (e: unknown): string => (e instanceof ApiCallError ? queueHttpErrorText(e.status, e.body) : queueHttpErrorText(0, null));

  const create = useCallback(async (body: CreateQueueItemBody) => {
    try {
      const item = await postJson("/queue", body, QueueItemDtoSchema);
      setItems((l) => upsertById(l, item));
      return { ok: true as const };
    } catch (e) {
      return { ok: false as const, error: fail(e) };
    }
  }, []);

  const update = useCallback(async (id: string, body: UpdateQueueItemBody) => {
    try {
      const item = await patchJson(`/queue/${id}`, body, QueueItemDtoSchema);
      setItems((l) => upsertById(l, item));
      return { ok: true as const };
    } catch (e) {
      return { ok: false as const, error: fail(e) };
    }
  }, []);

  const act = useCallback(async (id: string, action: "run-now" | "cancel"): Promise<string | null> => {
    try {
      const item = await postJson(`/queue/${id}/${action}`, {}, QueueItemDtoSchema);
      setItems((l) => upsertById(l, item));
      return null;
    } catch (e) {
      load();
      return fail(e);
    }
  }, [load]);

  const remove = useCallback(async (id: string): Promise<string | null> => {
    try {
      await requestJson("DELETE", `/queue/${id}`);
      setItems((l) => l.filter((i) => i.id !== id));
      return null;
    } catch (e) {
      load();
      return fail(e);
    }
  }, [load]);

  return {
    items,
    loaded,
    error,
    create,
    update,
    runNow: (id) => act(id, "run-now"),
    cancel: (id) => act(id, "cancel"),
    remove,
    reload: load,
  };
}
