import { z } from 'zod';

/**
 * Sessiya holatlari. Tartib ahamiyatsiz; ko'rsatish tartibi klientda.
 * `awaiting_approval` (1.4): PermissionRequest navbatda (agentd yuboradi). `stale` holat EMAS:
 * mashina offline bo'lganda sessiya `stale_since` bilan belgilanadi, holati o'zgarmaydi.
 */
export const SESSION_STATUSES = ['idle', 'working', 'waiting', 'awaiting_approval', 'done', 'ended'] as const;
export const SessionStatusSchema = z.enum(SESSION_STATUSES);
export type SessionStatus = z.infer<typeof SessionStatusSchema>;

export function isSessionStatus(value: unknown): value is SessionStatus {
  return SessionStatusSchema.safeParse(value).success;
}
