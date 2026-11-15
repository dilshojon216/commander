"use client";

import { ListGroupsResponseSchema, ListMessagesResponseSchema } from "@commander/contracts";
import type { ListGroupsResponse, MessageDto } from "@commander/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { getJson } from "@/lib/client-api";
import { useLive } from "@/lib/live-client";
import { parsePush } from "@/lib/push";
import { mergeOlder, upsertMessage } from "@/lib/messaging-view";

/** Xabarlashuv guruhlari: yuklash + xabar/sessiya push'laridan keyin (debounce) qayta o'qish + 30 s himoya so'rovi. */
export function useMessagingGroups(): { data: ListGroupsResponse | null; error: string | null; reload: () => void } {
  const [data, setData] = useState<ListGroupsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback((signal?: AbortSignal) => {
    getJson("/messaging/groups", ListGroupsResponseSchema, signal)
      .then((r) => {
        setData(r);
        setError(null);
      })
      .catch((e: unknown) => {
        if (!signal?.aborted) setError(e instanceof Error ? e.message : "Xatolik");
      });
  }, []);

  useEffect(() => {
    const ctl = new AbortController();
    load(ctl.signal);
    const t = setInterval(() => load(), 30_000);
    return () => {
      ctl.abort();
      clearInterval(t);
      if (timer.current) clearTimeout(timer.current);
    };
  }, [load]);

  useLive(
    (type) => {
      if (type !== "message.created" && type !== "message.updated" && type !== "session.updated") return;
      if (timer.current) return;
      timer.current = setTimeout(
        () => {
          timer.current = null;
          load();
        },
        type === "session.updated" ? 3000 : 600,
      );
    },
    () => load(),
  );

  return { data, error, reload: () => load() };
}

/** Bitta guruh lentasi (komponent `key={groupKey}` bilan qayta yaratiladi): sahifalash (kursor) + `message.created/updated` push (faqat shu guruh). */
export function useGroupFeed(groupKey: string | null) {
  const [items, setItems] = useState<MessageDto[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(groupKey !== null);
  const [error, setError] = useState<string | null>(null);
  const keyRef = useRef(groupKey);

  const fetchPage = useCallback(
    (key: string, cur: string | null, signal?: AbortSignal) => {
      const qs = new URLSearchParams({ key, limit: "30" });
      if (cur) qs.set("cursor", cur);
      return getJson(`/messaging/messages?${qs}`, ListMessagesResponseSchema, signal);
    },
    [],
  );

  useEffect(() => {
    keyRef.current = groupKey;
    if (!groupKey) return;
    const ctl = new AbortController();
    fetchPage(groupKey, null, ctl.signal)
      .then((r) => {
        setItems(r.items);
        setCursor(r.nextCursor);
      })
      .catch((e: unknown) => {
        if (!ctl.signal.aborted) setError(e instanceof Error ? e.message : "Xatolik");
      })
      .finally(() => setLoading(false));
    return () => ctl.abort();
  }, [groupKey, fetchPage]);

  useLive(
    (type, payload) => {
      const e = parsePush(type, payload);
      if (!e || (e.type !== "message.created" && e.type !== "message.updated")) return;
      if (e.message.groupKey !== keyRef.current) return;
      setItems((l) => upsertMessage(l, e.message));
    },
    () => undefined,
  );

  const loadMore = useCallback(() => {
    if (!groupKey || !cursor || loading) return;
    setLoading(true);
    fetchPage(groupKey, cursor)
      .then((r) => {
        setItems((l) => mergeOlder(l, r.items));
        setCursor(r.nextCursor);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "Xatolik"))
      .finally(() => setLoading(false));
  }, [groupKey, cursor, loading, fetchPage]);

  const reload = useCallback(() => {
    if (!groupKey) return;
    fetchPage(groupKey, null)
      .then((r) => {
        setItems((l) => r.items.reduce((acc, m) => upsertMessage(acc, m), l));
      })
      .catch(() => undefined);
  }, [groupKey, fetchPage]);

  return { items, hasMore: cursor !== null, loading, error, loadMore, reload };
}
