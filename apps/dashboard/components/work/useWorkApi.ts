"use client";

import { CreateCommandResponseSchema, MdExtractResponseSchema, PatchBoardResponseSchema } from "@commander/contracts";
import type { AppendTasksBody, CommandDto, MdExtractResponse, TaskBoardColumn } from "@commander/contracts";
import { useCallback, useState } from "react";
import { useLiveData } from "@/components/LiveData";
import { ApiCallError, patchJson, postJson } from "@/lib/client-api";
import { summaryBody } from "@/lib/parts-view";
import { workHttpErrorText } from "@/lib/work-view";

/** Ish maydoni yozuvlari: xatolar o'zbekcha matnga o'giriladi, buyruqlar `LiveData`da kuzatiladi. */
export function useWorkApi(projectId: string) {
  const { trackCommand } = useLiveData();
  const [busy, setBusy] = useState(false);

  const fail = (e: unknown): never => {
    throw new Error(e instanceof ApiCallError ? workHttpErrorText(e.status, e.body) : workHttpErrorText(0, null));
  };

  const command = useCallback(
    async (path: string, body: unknown): Promise<CommandDto> => {
      setBusy(true);
      try {
        const r = await postJson(`/projects/${projectId}${path}`, body, CreateCommandResponseSchema, { "Idempotency-Key": crypto.randomUUID() });
        trackCommand(r.command);
        return r.command;
      } catch (e) {
        return fail(e);
      } finally {
        setBusy(false);
      }
    },
    [projectId, trackCommand],
  );

  return {
    busy,
    refresh: () => command("/refresh", {}),
    summarize: (date: string, part?: string) => command(`/daily/${date}/summary`, summaryBody(part)),
    append: (body: AppendTasksBody) => command("/tasks/append", body),
    async extract(path: string): Promise<MdExtractResponse> {
      try {
        return await postJson(`/projects/${projectId}/md-extract`, { path }, MdExtractResponseSchema);
      } catch (e) {
        return fail(e);
      }
    },
    async moveTask(taskKey: string, column: TaskBoardColumn) {
      try {
        return await patchJson(`/projects/${projectId}/tasks/${encodeURIComponent(taskKey)}/board`, { column }, PatchBoardResponseSchema);
      } catch (e) {
        return fail(e);
      }
    },
  };
}
