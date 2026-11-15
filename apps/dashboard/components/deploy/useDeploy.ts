"use client";

import { CommandDtoSchema, CreateCommandResponseSchema, DeployInspectResponseSchema, DeployRunsResponseSchema } from "@commander/contracts";
import type { CommandDto, DeployInspectResult, DeployRunBody, DeployRunDto } from "@commander/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";
import { useLiveData } from "@/components/LiveData";
import { ApiCallError, getJson, postJson } from "@/lib/client-api";
import { deployErrorText, deployHttpErrorText } from "@/lib/deploy-ui";

const fail = (e: unknown): string => (e instanceof ApiCallError ? deployHttpErrorText(e.status, e.body) : deployHttpErrorText(0, null));

export interface InspectState {
  data: DeployInspectResult | null;
  loading: boolean;
  error: string | null;
  /** Retseptni agentdan o'qiydi (faqat o'qish; ~45 s gacha kutadi). */
  inspect: () => Promise<void>;
}

/** "Retseptni tekshirish": `POST /projects/:id/deploy/inspect`. Natija markazda 2 daqiqa xotirada: shu sahifada saqlanadi. */
export function useDeployInspect(projectId: string): InspectState {
  const [data, setData] = useState<DeployInspectResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

  const inspect = useCallback(async () => {
    const my = ++seq.current;
    setLoading(true);
    setError(null);
    try {
      const r = await postJson(`/projects/${projectId}/deploy/inspect`, {}, DeployInspectResponseSchema);
      if (seq.current !== my) return;
      if (r.inspect) setData(r.inspect);
      else {
        setData(null);
        setError(deployErrorText(r.errorCode) + (r.errorMessage ? ` (${r.errorMessage})` : ""));
      }
    } catch (e) {
      if (seq.current === my) setError(fail(e));
    } finally {
      if (seq.current === my) setLoading(false);
    }
  }, [projectId]);

  return { data, loading, error, inspect };
}

/** Deploy tarixi (`GET /projects/:id/deploy/runs`): xulosa, chiqishsiz. */
export function useDeployRuns(projectId: string): { items: DeployRunDto[] | null; error: string | null; reload: () => void } {
  const [items, setItems] = useState<DeployRunDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const ctl = new AbortController();
    getJson(`/projects/${projectId}/deploy/runs`, DeployRunsResponseSchema, ctl.signal)
      .then((r) => {
        setItems(r.items);
        setError(null);
      })
      .catch((e: unknown) => {
        if (!ctl.signal.aborted) setError(fail(e));
      });
    return () => ctl.abort();
  }, [projectId, tick]);
  return { items, error, reload: () => setTick((t) => t + 1) };
}

const ConfirmResponseSchema = z.object({ outcome: z.string(), command: CommandDtoSchema });

const CONFIRM_OUTCOME_TEXT: Record<string, string> = {
  confirmed: "Tasdiqlandi",
  not_pending: "Allaqachon hal qilingan",
  expired: "Tasdiq muddati o'tgan",
  same_device: "So'rovchi qurilma o'zini tasdiqlay olmaydi",
  lockdown: "Lockdown: buyruq rad etildi",
  lost: "Buyruq ma'lumoti yo'qolgan (qayta yarating)",
};

/**
 * deploy run/rollback yaratish va (review.required bo'lsa) dashboard'da tasdiqlash. Buyruq `LiveData`da kuzatiladi.
 * Elevation (Touch ID/parol) `apiFetch` darajasida avtomatik so'raladi (`elevation_required` -> qayta autentifikatsiya).
 */
export function useDeployActions(projectId: string) {
  const { trackCommand } = useLiveData();
  const [busy, setBusy] = useState(false);

  const create = useCallback(
    async (kind: "run" | "rollback", body: DeployRunBody): Promise<CommandDto> => {
      setBusy(true);
      try {
        const r = await postJson(`/projects/${projectId}/deploy/${kind}`, body, CreateCommandResponseSchema, { "Idempotency-Key": crypto.randomUUID() });
        trackCommand(r.command);
        return r.command;
      } catch (e) {
        throw new Error(fail(e));
      } finally {
        setBusy(false);
      }
    },
    [projectId, trackCommand],
  );

  const confirm = useCallback(
    async (commandId: string): Promise<string> => {
      try {
        const r = await postJson(`/commands/${commandId}/confirm`, {}, ConfirmResponseSchema);
        trackCommand(r.command);
        return CONFIRM_OUTCOME_TEXT[r.outcome] ?? r.outcome;
      } catch (e) {
        throw new Error(e instanceof ApiCallError ? e.message : "Xatolik");
      }
    },
    [trackCommand],
  );

  return { busy, run: (b: DeployRunBody) => create("run", b), rollback: (b: DeployRunBody) => create("rollback", b), confirm };
}
