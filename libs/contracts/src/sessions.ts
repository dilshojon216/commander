import { z } from 'zod';
import { SessionStatusSchema } from './session-status.js';

/** ISO-8601 satr (JSON'da Date shunday serializatsiya bo'ladi). */
const IsoDateString = z.string();

/** GET /sessions javobidagi bitta element. */
export const SessionSchema = z.object({
  host: z.string(),
  session_id: z.string(),
  cwd: z.string(),
  project: z.string(),
  status: SessionStatusSchema,
  message: z.string().nullable(),
  notification_type: z.string().nullable(),
  started_at: IsoDateString,
  status_since: IsoDateString,
  last_seen_at: IsoDateString,
  ended_at: IsoDateString.nullable(),
});
export type Session = z.infer<typeof SessionSchema>;

export const ListSessionsResponseSchema = z.array(SessionSchema);
export type ListSessionsResponse = z.infer<typeof ListSessionsResponseSchema>;

/**
 * GET /sessions/:host/:id/events javobidagi bitta element (eng yangisi birinchi).
 * `id` — bigint, JSON'da satr; `status` serverda erkin matn sifatida saqlanadi.
 */
export const SessionEventSchema = z.object({
  id: z.string(),
  host: z.string(),
  session_id: z.string(),
  event: z.string(),
  status: z.string(),
  message: z.string().nullable(),
  client_ts: z.number(),
  received_at: IsoDateString,
});
export type SessionEvent = z.infer<typeof SessionEventSchema>;

export const ListSessionEventsResponseSchema = z.array(SessionEventSchema);
export type ListSessionEventsResponse = z.infer<typeof ListSessionEventsResponseSchema>;
