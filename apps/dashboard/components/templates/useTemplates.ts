"use client";

import { CreateCommandResponseSchema, ListTemplatesResponseSchema, RenderTemplateResponseSchema, TemplateDtoSchema } from "@commander/contracts";
import type { CommandDto, CreateTemplateBody, RenderTemplateBody, RenderTemplateResponse, TemplateDto, UpdateTemplateBody } from "@commander/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { useLiveData } from "@/components/LiveData";
import { ApiCallError, getJson, patchJson, postJson, requestJson } from "@/lib/client-api";
import { templateHttpErrorText } from "./template-vm";

const fail = (e: unknown): string => (e instanceof ApiCallError ? templateHttpErrorText(e.status, e.body) : templateHttpErrorText(0, null));
export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

/** Shablonlar ro'yxati (`projectId` berilsa: global + loyiha + repo; berilmasa hammasi). */
export function useTemplateList(opts: { projectId?: string | null; all?: boolean } = {}) {
  const [items, setItems] = useState<TemplateDto[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const aborter = useRef<AbortController | null>(null);
  const key = opts.all ? "all" : (opts.projectId ?? "global");

  const load = useCallback(() => {
    aborter.current?.abort();
    const ctl = new AbortController();
    aborter.current = ctl;
    const qs = opts.all ? "" : opts.projectId ? `?projectId=${opts.projectId}` : "?scope=global";
    getJson(`/templates${qs}`, ListTemplatesResponseSchema, ctl.signal)
      .then((r) => {
        setItems(r.items);
        setLoaded(true);
        setError(null);
      })
      .catch((e: unknown) => {
        if (!ctl.signal.aborted) setError(e instanceof Error ? e.message : "Xatolik");
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` opts'ni qamraydi
  }, [key]);

  useEffect(() => {
    load();
    return () => aborter.current?.abort();
  }, [load]);

  return { items, loaded, error, reload: load };
}

/** Yozuvlar va render (xatolar o'zbekcha matn). */
export const templateApi = {
  async create(body: CreateTemplateBody): Promise<Result<TemplateDto>> {
    try {
      return { ok: true, value: await postJson("/templates", body, TemplateDtoSchema) };
    } catch (e) {
      return { ok: false, error: fail(e) };
    }
  },
  async update(id: string, body: UpdateTemplateBody): Promise<Result<TemplateDto>> {
    try {
      return { ok: true, value: await patchJson(`/templates/${id}`, body, TemplateDtoSchema) };
    } catch (e) {
      return { ok: false, error: fail(e) };
    }
  },
  async remove(id: string): Promise<Result<null>> {
    try {
      await requestJson("DELETE", `/templates/${id}`);
      return { ok: true, value: null };
    } catch (e) {
      return { ok: false, error: fail(e) };
    }
  },
  async render(id: string, body: RenderTemplateBody): Promise<Result<RenderTemplateResponse>> {
    try {
      return { ok: true, value: await postJson(`/templates/${id}/render`, body, RenderTemplateResponseSchema) };
    } catch (e) {
      return { ok: false, error: fail(e) };
    }
  },
};

/** Shablonni sessiyaga prompt qilib yuboradi; buyruq kuzatuv uchun `trackCommand` ga beriladi. */
export function useSendTemplate() {
  const { trackCommand } = useLiveData();
  const [submitting, setSubmitting] = useState(false);
  const send = useCallback(
    async (templateId: string, sessionId: string, taskKey?: string): Promise<Result<CommandDto>> => {
      setSubmitting(true);
      try {
        const res = await postJson(`/templates/${templateId}/send-prompt`, { sessionId, ...(taskKey ? { taskKey } : {}) }, CreateCommandResponseSchema, { "Idempotency-Key": crypto.randomUUID() });
        trackCommand(res.command);
        return { ok: true, value: res.command };
      } catch (e) {
        return { ok: false, error: fail(e) };
      } finally {
        setSubmitting(false);
      }
    },
    [trackCommand],
  );
  return { send, submitting };
}
