import type { ArchivedProjectsSummary, ProjectDto, SessionDto } from "@commander/contracts";

export type ProjectSortKey = "name" | "machine" | "today" | "all" | "req" | "open" | "last";

/** Loyihalar jadvali tartibi (barqaror: teng bo'lsa nom bo'yicha). */
export function sortProjects(items: ProjectDto[], key: ProjectSortKey, dir: 1 | -1, machineName: (p: ProjectDto) => string): ProjectDto[] {
  const val = (p: ProjectDto): number | string => {
    switch (key) {
      case "name":
        return p.name.toLowerCase();
      case "machine":
        return machineName(p).toLowerCase();
      case "today":
        return p.today.totalTokens;
      case "all":
        return p.allTime.totalTokens;
      case "req":
        return p.today.requests;
      case "open":
        return p.openSessions;
      case "last":
        return p.lastUsedAt ? Date.parse(p.lastUsedAt) : 0;
    }
  };
  return [...items].sort((a, b) => {
    const x = val(a);
    const y = val(b);
    const c = typeof x === "string" && typeof y === "string" ? x.localeCompare(y) : Number(x) - Number(y);
    return c * dir || a.name.localeCompare(b.name);
  });
}

/**
 * Loyihaning haqiqiy oxirgi faolligi: markaz `lastUsedAt` (eski centerda kun boshi aniqligida: hamma loyiha bir xil chiqardi)
 * va shu loyiha sessiyalarining eng yangi `lastSeenAt`i orasidagi kattasi.
 */
export function projectLastActivity(p: Pick<ProjectDto, "id" | "lastUsedAt">, sessions: ReadonlyArray<Pick<SessionDto, "projectId" | "lastSeenAt">>): string | null {
  let best = p.lastUsedAt ? Date.parse(p.lastUsedAt) : Number.NaN;
  for (const s of sessions) {
    if (s.projectId !== p.id) continue;
    const t = Date.parse(s.lastSeenAt);
    if (!Number.isNaN(t) && (Number.isNaN(best) || t > best)) best = t;
  }
  return Number.isNaN(best) ? null : new Date(best).toISOString();
}

/** `lastUsedAt` o'rniga haqiqiy oxirgi faollik qo'yilgan loyihalar (saralash ham shu bo'yicha). */
export function withLastActivity(items: ProjectDto[], sessions: ReadonlyArray<Pick<SessionDto, "projectId" | "lastSeenAt">>): ProjectDto[] {
  return items.map((p) => {
    const last = projectLastActivity(p, sessions);
    return last === p.lastUsedAt ? p : { ...p, lastUsedAt: last };
  });
}

// --- 6.16 Arxivlash -------------------------------------------------------------------------------------------------

/** Center REST yo'li (dashboard proksi `/api/c` + shu yo'l). */
export function archivePath(projectId: string, archive: boolean): string {
  return `/projects/${projectId}/${archive ? "archive" : "unarchive"}`;
}

export function archiveActionLabel(archivedAt: string | null): string {
  return archivedAt ? "Arxivdan chiqarish" : "Arxivlash";
}

/** "Arxivlanganlar (N)" tugmasi; ochiq bo'lsa faol ro'yxatga qaytish. */
export function archivedToggleLabel(count: number, showing: boolean): string {
  return showing ? "Faol loyihalar" : `Arxivlanganlar (${count})`;
}

/** Arxiv bo'sh bo'lsa va ko'rsatilmayotgan bo'lsa tugma kerak emas. */
export function showArchivedToggle(count: number, showing: boolean): boolean {
  return showing || count > 0;
}

export const ARCHIVE_HINT = "Ro'yxatlardan yashiradi. Tarix va tokenlar saqlanadi; shu loyihada yangi sessiya boshlansa o'zi qaytadi.";

export function archiveErrorText(err: unknown, archive: boolean): string {
  const what = archive ? "arxivlab" : "arxivdan chiqarib";
  if (typeof err === "object" && err !== null && "status" in err) {
    const status = (err as { status: unknown }).status;
    if (status === 404) return "Loyiha topilmadi (allaqachon o'chirilgan bo'lishi mumkin)";
    if (status === 403) return "Ruxsat yo'q: boshqaruv tokeni kerak";
  }
  return `Loyihani ${what} bo'lmadi`;
}

export interface TopProjectRow {
  key: string;
  name: string;
  tokens: number;
  requests: number;
  /** `null` = jamlangan qator (havola yo'q). */
  projectId: string | null;
  machineId: string | null;
}

export const OTHERS_ROW_KEY = "__others__";

/**
 * "Bugungi tokenlar · loyiha bo'yicha": faol loyihalar reytingi; arxivlangan loyihalar tokenlari (haqiqiy, jamiga kiradi) reytingda
 * ko'rinmaydi, ularning bugungi yig'indisi "Boshqalar" qatoriga qo'shiladi. `limit` faqat loyiha qatorlariga tegishli.
 */
export function topProjectsToday(items: ReadonlyArray<ProjectDto>, archived: Pick<ArchivedProjectsSummary, "today"> | null | undefined, limit = 5): TopProjectRow[] {
  const rows: TopProjectRow[] = items
    .filter((p) => p.archivedAt === null && p.today.totalTokens > 0)
    .sort((a, b) => b.today.totalTokens - a.today.totalTokens || a.name.localeCompare(b.name))
    .slice(0, limit)
    .map((p) => ({ key: p.id, name: p.name, tokens: p.today.totalTokens, requests: p.today.requests, projectId: p.id, machineId: p.machineId }));
  const hidden = archived?.today.totalTokens ?? 0;
  if (hidden > 0) rows.push({ key: OTHERS_ROW_KEY, name: "Boshqalar (arxivlangan)", tokens: hidden, requests: archived?.today.requests ?? 0, projectId: null, machineId: null });
  return rows;
}

/** Mashina bo'yicha bugungi tokenlar: faol loyihalar + arxivlanganlar (mashina jami qiymati arxiv tufayli kamaymaydi). */
export function todayTokensByMachine(items: ReadonlyArray<ProjectDto>, archived: Pick<ArchivedProjectsSummary, "todayByMachine"> | null | undefined): Map<string, number> {
  const m = new Map<string, number>();
  for (const p of items) m.set(p.machineId, (m.get(p.machineId) ?? 0) + p.today.totalTokens);
  for (const a of archived?.todayByMachine ?? []) m.set(a.machineId, (m.get(a.machineId) ?? 0) + a.totalTokens);
  return m;
}
