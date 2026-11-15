import { z } from 'zod';
import { SessionStatusSchema } from './session-status.js';

/**
 * POST /events tanasi (hozirgi v0 kontrakt, snake_case).
 * Eslatma: center `message` ni 2000 va `notification_type` ni 64 belgigacha
 * jimgina qisqartiradi (rad etmaydi) — bu yerda chegara qo'yilmagan.
 */
export const CreateEventBodySchema = z.object({
  host: z.string().min(1).max(255),
  session_id: z.string().min(1).max(255),
  cwd: z.string().min(1).max(4096),
  event: z.string().min(1).max(64),
  status: SessionStatusSchema,
  message: z.string().nullish(),
  notification_type: z.string().nullish(),
  /** Klient vaqti, epoch millisekund. */
  ts: z.number().finite().min(0).max(8.64e15),
});
export type CreateEventBody = z.infer<typeof CreateEventBodySchema>;
