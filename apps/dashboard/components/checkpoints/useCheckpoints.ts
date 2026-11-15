"use client";

import { CheckpointListResultSchema, CheckpointResultSchema, CreateCommandResponseSchema } from "@commander/contracts";
import type { CheckpointAutoSettings, CheckpointInfo, CheckpointResult, CommandDto, DiffResponse } from "@commander/contracts";
import { useCallback, useEffect, useState } from "react";
import { z } from "zod";
import { useGitApi } from "@/components/git/useGit";
import { useLiveData } from "@/components/LiveData";
import { ApiCallError, getJson, postJson, requestJson } from "@/lib/client-api";
import { deployHttpErrorText } from "@/lib/deploy-ui";

const fail = (e: unknown): string => (e instanceof ApiCallError ? deployHttpErrorText(e.status, e.body) : deployHttpErrorText(0, null));

const ListResponseSchema = z.object({ commandId: z.string(), result: CheckpointListResultSchema });
const CreateResponseSchema = z.object({ commandId: z.string(), result: CheckpointResultSchema });
const SettingsSchema = z.object({ bigTask: z.boolean(), orchestration: z.boolean() });

/** Checkpoint ro'yxati (`POST .../checkpoints/list`: faqat o'qish; elevation yo'q). Tab ochilganda bir marta, so'ng qo'lda/yaratgandan keyin. */
export function useCheckpointList(projectId: string): { items: CheckpointInfo[] | null; total: number; loading: boolean; error: string | null; reload: () => void } {
  const [items, setItems] = useState<CheckpointInfo[] | null>(null);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    postJson(`/projects/${projectId}/checkpoints/list`, {}, ListResponseSchema)
      .then((r) => {
        if (!live) return;
        setItems(r.result.items);
        setTotal(r.result.total);
        setError(null);
      })
      .catch((e: unknown) => {
        if (live) setError(fail(e));
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [projectId, tick]);
  return {
    items,
    total,
    loading,
    error,
    reload: () => {
      setLoading(true);
      setTick((t) => t + 1);
    },
  };
}

/** Yozuvlar: yaratish (sinxron), diff (checkpoint bazasi bilan), qaytarish (step-up, elevation har doim). */
export function useCheckpointActions(projectId: string) {
  const { trackCommand } = useLiveData();
  const git = useGitApi();
  const [busy, setBusy] = useState(false);
  return {
    busy,
    async create(label: string): Promise<CheckpointResult> {
      setBusy(true);
      try {
        return (await postJson(`/projects/${projectId}/checkpoints`, { label }, CreateResponseSchema)).result;
      } catch (e) {
        throw new Error(fail(e));
      } finally {
        setBusy(false);
      }
    },
    /** Ishchi daraxt vs checkpoint commit'i: mavjud loyiha diff endpoint'i (`base` = checkpoint sha). */
    diff: (sha: string): Promise<DiffResponse> => git.diffProject(projectId, sha),
    async restore(ref: string): Promise<CommandDto> {
      setBusy(true);
      try {
        const r = await postJson(`/projects/${projectId}/checkpoints/restore`, { ref }, CreateCommandResponseSchema, { "Idempotency-Key": crypto.randomUUID() });
        trackCommand(r.command);
        return r.command;
      } catch (e) {
        throw new Error(fail(e));
      } finally {
        setBusy(false);
      }
    },
  };
}

/** Avto-checkpoint tugmalari (`GET/PUT /checkpoints/settings`; PUT elevation talab qiladi). */
export function useCheckpointSettings(): { settings: CheckpointAutoSettings | null; error: string | null; saving: boolean; set: (next: CheckpointAutoSettings) => Promise<void> } {
  const [settings, setSettings] = useState<CheckpointAutoSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    const ctl = new AbortController();
    getJson("/checkpoints/settings", SettingsSchema, ctl.signal)
      .then(setSettings)
      .catch((e: unknown) => {
        if (!ctl.signal.aborted) setError(fail(e));
      });
    return () => ctl.abort();
  }, []);
  const set = useCallback(async (next: CheckpointAutoSettings) => {
    setSaving(true);
    setError(null);
    try {
      await requestJson("PUT", "/checkpoints/settings", next);
      setSettings(await getJson("/checkpoints/settings", SettingsSchema));
    } catch (e) {
      setError(fail(e));
    } finally {
      setSaving(false);
    }
  }, []);
  return { settings, error, saving, set };
}
