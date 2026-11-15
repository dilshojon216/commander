import { z } from 'zod';

/** Agent va client protokollari umumiy envelope'i. */
export const AGENT_PROTOCOL_VERSION = 1 as const;

/** Epoch millisekund, butun son. 2100-yil bilan cheklangan (Postgres timestamptz diapazoni uchun). */
export const EpochMsSchema = z.number().int().min(0).max(4_102_444_800_000);

/**
 * Har xabar: `{ v: 1, id: uuid, type, ts, payload }`. `id` — xabar identifikatori (ack shuni
 * qaytaradi). `ts` — jo'natuvchi vaqti, epoch ms.
 */
export const EnvelopeSchema = z.object({
  v: z.literal(AGENT_PROTOCOL_VERSION),
  id: z.uuid(),
  type: z.string().min(1).max(64),
  ts: EpochMsSchema,
  payload: z.unknown(),
});
export type Envelope = z.infer<typeof EnvelopeSchema>;

/** Typed envelope sxemasi yasovchi (agent va client protokollari umumiy ishlatadi). */
export function envelopeMessage<T extends string, P extends z.ZodType>(type: T, payload: P) {
  return z.object({
    v: z.literal(AGENT_PROTOCOL_VERSION),
    id: z.uuid(),
    type: z.literal(type),
    ts: EpochMsSchema,
    payload,
  });
}

/** Typed envelope yasash (id = yangi uuid, ts = hozir). Brauzer va Node 22 da `crypto.randomUUID`. */
export function createEnvelope<T extends string, P>(
  type: T,
  payload: P,
  now: number = Date.now(),
  id: string = globalThis.crypto.randomUUID(),
): { v: typeof AGENT_PROTOCOL_VERSION; id: string; type: T; ts: number; payload: P } {
  return { v: AGENT_PROTOCOL_VERSION, id, type, ts: now, payload };
}

