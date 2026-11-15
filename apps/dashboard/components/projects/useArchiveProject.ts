"use client";

import { useCallback, useState } from "react";
import { useLiveData } from "@/components/LiveData";
import { requestJson } from "@/lib/client-api";
import { archiveErrorText, archivePath } from "@/lib/projects-view";

/**
 * 6.16: loyihani arxivlash/qaytarish. Yozish proksi orqali (`control` token + elevation: kerak bo'lsa Touch ID/parol oynasi `apiFetch`
 * ichida chiqadi). Muvaffaqiyatdan keyin faol ro'yxat qayta o'qiladi; `onDone` arxiv ro'yxatini yangilaydi.
 */
export function useArchiveProject(onDone?: () => void) {
  const { refreshProjects, canControl } = useLiveData();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(
    async (id: string, archive: boolean): Promise<boolean> => {
      setBusyId(id);
      setError(null);
      try {
        await requestJson("POST", archivePath(id, archive), {});
        await refreshProjects().catch(() => undefined);
        onDone?.();
        return true;
      } catch (e) {
        setError(archiveErrorText(e, archive));
        return false;
      } finally {
        setBusyId(null);
      }
    },
    [refreshProjects, onDone],
  );

  return { run, busyId, error, clearError: () => setError(null), canControl };
}
