import type { SessionDto } from "@commander/contracts";
import { STATUS_ORDER } from "./status";
import { isActiveSession, isStaleIdle } from "./sessions-view";

/** Sessiyalarni holat bo'yicha (ruxsat kutayotganlar yuqorida), keyin holatda turgan vaqt bo'yicha tartiblaydi. */
export function sortSessionList(list: SessionDto[]): SessionDto[] {
  return [...list].sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || Date.parse(a.statusSince) - Date.parse(b.statusSince));
}

/** Faol sessiyalar (tugamagan, oyna ichida va 6 soatdan ortiq "bo'sh" qolib eskirmagan), tartiblangan. */
export function activeSessions(list: SessionDto[], now: number): SessionDto[] {
  return sortSessionList(list.filter((s) => isActiveSession(s, now) && !isStaleIdle(s, now)));
}

/** "Qisqa xabar": sessiya xabari yoki "—". */
export function lastMessage(s: Pick<SessionDto, "message">): string {
  return s.message?.trim() || "—";
}
