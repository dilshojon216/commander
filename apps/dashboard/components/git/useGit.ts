"use client";

import { CreateCommandResponseSchema, DiffResponseSchema, ProjectDetailDtoSchema, ProjectGitResponseSchema, ProjectTasksResponseSchema } from "@commander/contracts";
import type { CommandDto, DiffResponse, OpenPrBody, ProjectDetailDto, ProjectGitResponse, ProjectTasksResponse } from "@commander/contracts";
import { useCallback, useEffect, useState } from "react";
import { useLiveData } from "@/components/LiveData";
import { ApiCallError, getJson, postJson } from "@/lib/client-api";
import { gitHttpErrorText } from "@/lib/git-view";
import { useLiveSync } from "@/lib/use-live-sync";

/** Loyihaning Git holati (CI, PR, vazifaga bog'langan commitlar): snapshot + `project.updated` push. `projectId = null` = so'ralmaydi. */
export function useProjectGit(projectId: string | null): { git: ProjectGitResponse | null; error: string | null; reload: () => void } {
  const [git, setGit] = useState<ProjectGitResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(
    (signal?: AbortSignal) => (projectId ? getJson(`/projects/${projectId}/git`, ProjectGitResponseSchema, signal) : Promise.resolve(null)),
    [projectId],
  );
  useLiveSync<ProjectGitResponse | null>({
    fetchSnapshot: (signal) => load(signal),
    onSnapshot: setGit,
    onError: setError,
    onPush: (e) => {
      if (e.type === "project.updated" && e.project.id === projectId) {
        load()
          .then((d) => {
            setGit(d);
            setError(null);
          })
          .catch(() => undefined);
      }
    },
  });
  const reload = useCallback(() => {
    load()
      .then((d) => {
        setGit(d);
        setError(null);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "Xatolik"));
  }, [load]);
  return { git, error, reload };
}

/** Git yozuvlari/so'rovlari: xatolar o'zbekcha matnga o'giriladi; buyruqlar `LiveData`da kuzatiladi. */
export function useGitApi() {
  const { trackCommand } = useLiveData();
  const [busy, setBusy] = useState(false);

  const fail = (e: unknown): never => {
    throw new Error(e instanceof ApiCallError ? gitHttpErrorText(e.status, e.body) : gitHttpErrorText(0, null));
  };

  return {
    busy,
    async diffProject(projectId: string, base?: string): Promise<DiffResponse> {
      try {
        return await postJson(`/projects/${projectId}/diff`, base ? { base } : {}, DiffResponseSchema);
      } catch (e) {
        return fail(e);
      }
    },
    async diffSession(sessionId: string): Promise<DiffResponse> {
      try {
        return await postJson(`/sessions/${sessionId}/diff`, {}, DiffResponseSchema);
      } catch (e) {
        return fail(e);
      }
    },
    async openPr(projectId: string, body: OpenPrBody): Promise<CommandDto> {
      setBusy(true);
      try {
        const r = await postJson(`/projects/${projectId}/pr`, body, CreateCommandResponseSchema, { "Idempotency-Key": crypto.randomUUID() });
        trackCommand(r.command);
        return r.command;
      } catch (e) {
        return fail(e);
      } finally {
        setBusy(false);
      }
    },
    async refreshCi(projectId: string, branch?: string): Promise<CommandDto> {
      setBusy(true);
      try {
        const r = await postJson(`/projects/${projectId}/ci/refresh`, branch ? { branch } : {}, CreateCommandResponseSchema, { "Idempotency-Key": crypto.randomUUID() });
        trackCommand(r.command);
        return r.command;
      } catch (e) {
        return fail(e);
      } finally {
        setBusy(false);
      }
    },
  };
}

/** PR dialogi uchun loyiha konteksti (branch, oxirgi commitlar, vazifa sarlavhasi): best-effort. */
export function useProjectContext(projectId: string | null, taskKey: string | null | undefined): { detail: ProjectDetailDto | null; tasks: ProjectTasksResponse | null; ready: boolean } {
  const [detail, setDetail] = useState<ProjectDetailDto | null>(null);
  const [tasks, setTasks] = useState<ProjectTasksResponse | null>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (!projectId) return;
    const ctl = new AbortController();
    void Promise.all([
      getJson(`/projects/${projectId}`, ProjectDetailDtoSchema, ctl.signal).catch(() => null),
      taskKey ? getJson(`/projects/${projectId}/tasks`, ProjectTasksResponseSchema, ctl.signal).catch(() => null) : Promise.resolve(null),
    ]).then(([d, t]) => {
      if (ctl.signal.aborted) return;
      setDetail(d);
      setTasks(t);
      setReady(true);
    });
    return () => ctl.abort();
  }, [projectId, taskKey]);
  return { detail, tasks, ready };
}
