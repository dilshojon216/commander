import type { SessionDto } from "@commander/contracts";
import { STATUS_ORDER } from "./status";

/** Tugamagan va `STALE_MINUTES` (12 soat) ichida ko'rilgan (server `active=1` ta'rifi bilan bir xil). */
export const ACTIVE_WINDOW_MS = 12 * 3_600_000;

export function isActiveSession(s: Pick<SessionDto, "endedAt" | "lastSeenAt">, now: number): boolean {
  if (s.endedAt !== null) return false;
  if (!now) return true;
  return now - Date.parse(s.lastSeenAt) < ACTIVE_WINDOW_MS;
}

export function sortSessionDtos(list: SessionDto[]): SessionDto[] {
  return [...list].sort(
    (a, b) =>
      STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
      Date.parse(a.statusSince) - Date.parse(b.statusSince),
  );
}

export interface SessionFilter {
  machineId: string | null;
  status: SessionDto["status"] | null;
  text: string;
  showAll: boolean;
}

export function filterSessions(list: SessionDto[], f: SessionFilter, hiddenMachineIds: Set<string>, now: number): SessionDto[] {
  const q = f.text.trim().toLowerCase();
  return list.filter((s) => {
    if (hiddenMachineIds.has(s.machineId)) return false;
    if (!f.showAll && !isActiveSession(s, now)) return false;
    if (f.machineId && s.machineId !== f.machineId) return false;
    if (f.status && s.status !== f.status) return false;
    if (q && !`${s.projectName} ${s.machineName} ${s.cwd} ${s.message ?? ""}`.toLowerCase().includes(q)) return false;
    return true;
  });
}

/** Bo'sh (idle) sessiya shu muddatdan ortiq ko'rinmasa "Eskirgan": faol hisoblanmaydi, xira ko'rsatiladi. */
export const STALE_IDLE_MS = 6 * 3_600_000;

export function isStaleIdle(s: Pick<SessionDto, "endedAt" | "status" | "lastSeenAt">, now: number): boolean {
  if (s.endedAt !== null || s.status !== "idle" || !now) return false;
  return now - Date.parse(s.lastSeenAt) > STALE_IDLE_MS;
}

/** "Aktiv sessiyalar" sanog'i/ro'yxati: faol oynada va eskirgan bo'sh sessiyalarsiz. */
export function liveActiveSessions<T extends Pick<SessionDto, "endedAt" | "status" | "lastSeenAt">>(list: readonly T[], now: number): T[] {
  return list.filter((s) => isActiveSession(s, now) && !isStaleIdle(s, now));
}

/** Jadval ustunlari: "Oxirgi xabar" va "Ruxsat" ko'rinayotgan qatorlarning hech birida ma'lumot bo'lmasa yashiriladi. */
export function sessionColumns(rows: ReadonlyArray<Pick<SessionDto, "message" | "pendingApprovals">>): { message: boolean; approvals: boolean } {
  return { message: rows.some((s) => !!s.message?.trim()), approvals: rows.some((s) => s.pendingApprovals > 0) };
}
