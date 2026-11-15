"use client";

import {
  CaptureConfigResponseSchema,
  ConfigFileContentResponseSchema,
  ConfigProfileDetailSchema,
  ConfigSettingsResponseSchema,
  ConfigStatusResponseSchema,
  CreateCommandResponseSchema,
  ListConfigProfilesResponseSchema,
  ConfigDiffResponseSchema,
} from "@commander/contracts";
import type { CaptureConfigResponse, CommandDto, ConfigDiffResponse, ConfigFileContentResponse, ConfigMode, ConfigProfileDetail, ConfigProfileSummary, ConfigStatusResponse } from "@commander/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { useLiveData } from "@/components/LiveData";
import { configHttpErrorText } from "@/lib/config-ui";
import { ApiCallError, getJson, postJson, requestJson } from "@/lib/client-api";
import { useLive } from "@/lib/live-client";

const POLL_MS = 30_000;

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

const fail = (e: unknown): string => (e instanceof ApiCallError ? configHttpErrorText(e.status, e.body) : configHttpErrorText(0, null));

async function attempt<T>(fn: () => Promise<T>): Promise<Result<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (e) {
    return { ok: false, error: fail(e) };
  }
}

/** Profillar ro'yxati + mashinalar holati matritsasi (REST + 30 s so'rov + qayta ulanishda yangilash). Amallar `Result` qaytaradi. */
export function useConfigSync(profileName: string | null) {
  const { trackCommand } = useLiveData();
  const [profiles, setProfiles] = useState<ConfigProfileSummary[] | null>(null);
  const [status, setStatus] = useState<ConfigStatusResponse | null>(null);
  const [driftNotify, setDriftNotify] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const aborter = useRef<AbortController | null>(null);

  const load = useCallback(() => {
    aborter.current?.abort();
    const ctl = new AbortController();
    aborter.current = ctl;
    const q = profileName ? `?profile=${encodeURIComponent(profileName)}` : "";
    Promise.all([getJson("/config/profiles", ListConfigProfilesResponseSchema, ctl.signal), getJson(`/config/status${q}`, ConfigStatusResponseSchema, ctl.signal), getJson("/config/settings", ConfigSettingsResponseSchema, ctl.signal)])
      .then(([p, s, st]) => {
        setProfiles(p.items);
        setStatus(s);
        setDriftNotify(st.driftNotify);
        setError(null);
      })
      .catch((e: unknown) => {
        if (!ctl.signal.aborted) setError(e instanceof Error ? e.message : "Xatolik");
      });
  }, [profileName]);

  useEffect(() => {
    load();
    const t = setInterval(load, POLL_MS);
    return () => {
      aborter.current?.abort();
      clearInterval(t);
    };
  }, [load]);

  // agentd heartbeat'dagi config hisoboti markazda yangilanganda holat push bilan kelmaydi: buyruq tugashi va qayta ulanishda qayta o'qiymiz
  useLive(() => undefined, load);

  const detail = useCallback((id: string) => attempt<ConfigProfileDetail>(() => getJson(`/config/profiles/${id}`, ConfigProfileDetailSchema)), []);
  const fileContent = useCallback((id: string, path: string) => attempt<ConfigFileContentResponse>(() => getJson(`/config/profiles/${id}/file?path=${encodeURIComponent(path)}`, ConfigFileContentResponseSchema)), []);

  const capture = useCallback(
    async (machineId: string, name: string): Promise<Result<CaptureConfigResponse>> => {
      const r = await attempt(() => postJson("/config/profiles/capture", { machineId, name }, CaptureConfigResponseSchema, { "Idempotency-Key": crypto.randomUUID() }));
      load();
      return r;
    },
    [load],
  );

  const diff = useCallback((machineId: string, profileId: string, mode: ConfigMode) => attempt<ConfigDiffResponse>(() => postJson(`/config/machines/${machineId}/diff`, { profileId, mode }, ConfigDiffResponseSchema, { "Idempotency-Key": crypto.randomUUID() })), []);

  const command = useCallback(
    async (path: string, body: unknown): Promise<Result<CommandDto>> => {
      const r = await attempt(() => postJson(path, body, CreateCommandResponseSchema, { "Idempotency-Key": crypto.randomUUID() }));
      if (!r.ok) return r;
      trackCommand(r.value.command);
      return { ok: true, value: r.value.command };
    },
    [trackCommand],
  );

  const apply = useCallback((machineId: string, profileId: string, mode: ConfigMode, expectedPlanHash: string) => command(`/config/machines/${machineId}/apply`, { profileId, mode, expectedPlanHash }), [command]);
  const rollback = useCallback((machineId: string, backupId: string) => command(`/config/machines/${machineId}/rollback`, { backupId }), [command]);

  const setNotify = useCallback(async (value: boolean): Promise<string | null> => {
    try {
      await requestJson("PUT", "/config/settings", { driftNotify: value });
      setDriftNotify(value);
      return null;
    } catch (e) {
      return fail(e);
    }
  }, []);

  return { profiles, status, driftNotify, error, reload: load, detail, fileContent, capture, diff, apply, rollback, setNotify };
}
