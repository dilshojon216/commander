import type { SessionStatus } from '../database/entities/session.entity.js';

export interface EventInput {
  host: string;
  sessionId: string;
  cwd: string;
  status: SessionStatus;
  message: string | null;
  notificationType: string | null;
  /** Faqat agentd yo'li: tugash sababi (`vanished`, `logout`, ...). v0 hook yubormaydi. */
  endReason?: string | null;
  /** Faqat agentd yo'li: mashina-lokal transcript yo'li. */
  transcriptPath?: string | null;
  /** Faqat agentd yo'li: hook `permission_mode`. Yo'q bo'lsa avvalgisi saqlanadi. */
  permissionMode?: string | null;
}

/** Sessiya qatorining o'zgaruvchan holati (identity ustunlarisiz). */
export interface SessionState {
  cwd: string;
  project: string;
  status: SessionStatus;
  message: string | null;
  notificationType: string | null;
  startedAt: Date;
  statusSince: Date;
  lastSeenAt: Date;
  endedAt: Date | null;
  endReason: string | null;
  transcriptPath: string | null;
  permissionMode: string | null;
  staleSince: Date | null;
}

/** Last non-empty path segment; understands both POSIX and Windows separators. */
export function projectFromCwd(cwd: string): string {
  const parts = cwd.split(/[\\/]+/).filter((p) => p.length > 0);
  return parts.length > 0 ? parts[parts.length - 1] : cwd;
}

/**
 * Pure state transition for a session row. Ikkala yo'l (v0 POST /events va agentd WS) shuni ishlatadi.
 * - status_since only moves when the status actually changes (or on first sight);
 * - ended_at is set while status is 'ended' and cleared if the session comes back;
 * - last_seen_at = hodisa vaqti, lekin hech qachon orqaga ketmaydi (heartbeat uni oldinga surgan bo'lishi mumkin);
 * - end_reason faqat 'ended' holatida saqlanadi (qaytsa tozalanadi);
 * - stale_since har doim tozalanadi: hodisa kelishi mashina tirikligini isbotlaydi.
 */
export function applyEvent(existing: SessionState | null, input: EventInput, now: Date): SessionState {
  const statusChanged = !existing || existing.status !== input.status;
  const ended = input.status === 'ended';
  return {
    cwd: input.cwd,
    project: projectFromCwd(input.cwd),
    status: input.status,
    message: input.message,
    notificationType: input.notificationType,
    startedAt: existing?.startedAt ?? now,
    statusSince: statusChanged ? now : existing.statusSince,
    lastSeenAt: existing && existing.lastSeenAt.getTime() > now.getTime() ? existing.lastSeenAt : now,
    endedAt: ended ? (existing?.endedAt ?? now) : null,
    endReason: ended ? (input.endReason ?? existing?.endReason ?? null) : null,
    transcriptPath: input.transcriptPath ?? existing?.transcriptPath ?? null,
    permissionMode: input.permissionMode ?? existing?.permissionMode ?? null,
    staleSince: null,
  };
}

/**
 * Agent hodisasi sessiyaning joriy holatini o'zgartira oladimi? `statusSince` dan ESKI hodisa
 * (outbox'dan kechikib kelgan, tartibsiz) faqat jurnalga yoziladi: u yangiroq holatni bosib ketmasin.
 */
export function isOlderThanCurrentStatus(existing: Pick<SessionState, 'statusSince'> | null, at: Date): boolean {
  return existing !== null && at.getTime() < existing.statusSince.getTime();
}

/** Kelajakdagi vaqt serverda `now` ga tushiriladi (soat og'ishi sessiyani "kelajakda" qoldirmasin). */
export function clampToNow(ms: number, now: Date): Date {
  return new Date(Math.min(ms, now.getTime()));
}
