import { z } from 'zod';

/**
 * Markaz o'z-o'zini kuzatishi (5.5): DB disk, zaxira, dashboard, Tailscale serve, runtime, Telegram polling.
 * agentd offline (3.8) bu yerda takrorlanmaydi: faqat ochiq `offline` hodisalari soni ko'rsatiladi.
 */
export const CENTER_CHECK_KINDS = ['db_disk', 'backup', 'dashboard', 'tailscale', 'runtime', 'telegram'] as const;
export const CenterCheckKindSchema = z.enum(CENTER_CHECK_KINDS);
export type CenterCheckKind = z.infer<typeof CenterCheckKindSchema>;

/** `unknown` = hali o'lchanmagan/o'lchab bo'lmadi (hodisa ochilmaydi), `disabled` = sozlanmagan. */
export const CENTER_CHECK_STATUSES = ['ok', 'warn', 'critical', 'unknown', 'disabled'] as const;
export const CenterCheckStatusSchema = z.enum(CENTER_CHECK_STATUSES);
export type CenterCheckStatus = z.infer<typeof CenterCheckStatusSchema>;

export const CenterCheckDtoSchema = z.object({
  kind: CenterCheckKindSchema,
  status: CenterCheckStatusSchema,
  /** Qisqa o'zbekcha matn (sir/yo'l yo'q). */
  summary: z.string().max(300),
  /** Raqamli tafsilotlar (foiz, bayt, soniya). */
  metrics: z.record(z.string(), z.number().nullable()),
  checkedAt: z.string(),
});
export type CenterCheckDto = z.infer<typeof CenterCheckDtoSchema>;

export const CenterIncidentDtoSchema = z.object({
  id: z.uuid(),
  kind: CenterCheckKindSchema,
  severity: z.enum(['warn', 'critical']),
  summary: z.string(),
  openedAt: z.string(),
  resolvedAt: z.string().nullable(),
});
export type CenterIncidentDto = z.infer<typeof CenterIncidentDtoSchema>;

export const CenterHealthResponseSchema = z.object({
  checkedAt: z.string().nullable(),
  /** Eng yomon holat (`unknown`/`disabled` hisobga olinmaydi). */
  status: z.enum(['ok', 'warn', 'critical']),
  checks: z.array(CenterCheckDtoSchema),
  /** Ochiq hodisalar + oxirgi 24 soatda yopilganlar. */
  incidents: z.array(CenterIncidentDtoSchema),
  /** 3.8: ochiq `offline` hodisalari (agentd offline > 10 daqiqa). */
  machinesOffline: z.number().int().min(0),
  uptimeSec: z.number().int().min(0),
});
export type CenterHealthResponse = z.infer<typeof CenterHealthResponseSchema>;
