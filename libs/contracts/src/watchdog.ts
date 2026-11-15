import { z } from 'zod';
import { envelopeMessage } from './envelope.js';

/**
 * Watchdog (task 3.2): qotib qolgan / ortiqcha sarflayotgan / xatoni takrorlayotgan sessiyalar.
 * Ogohlantirishlar `watchdog_alerts` jadvalida; matn saqlanmaydi (faqat raqam va xesh). Avtomatik to'xtatish sukut bo'yicha O'CHIQ.
 */

export const ALERT_KINDS = ['waiting', 'burn', 'error_loop'] as const;
export const AlertKindSchema = z.enum(ALERT_KINDS);
export type AlertKind = z.infer<typeof AlertKindSchema>;

export const ALERT_STATES = ['open', 'resolved', 'dismissed'] as const;
export const AlertStateSchema = z.enum(ALERT_STATES);
export type AlertState = z.infer<typeof AlertStateSchema>;

export const WATCHDOG_LIMITS = {
  maxOverrides: 200,
  /** Telegram eslatmalari: birinchi xabardan keyin eng ko'pi bilan shuncha qayta eslatma. */
  maxReminders: 3,
  reminderGapMs: 3_600_000,
  /** Sarf/xato ogohlantirishidan keyin xuddi shu turdagi yangisi uchun sovish vaqti. */
  cooldownMs: 30 * 60_000,
  burnWindowMs: 10 * 60_000,
  errorLoopWindowMs: 10 * 60_000,
} as const;

export const WatchdogThresholdsSchema = z.object({
  waitingMinutes: z.number().int().min(1).max(1440),
  burnWeightedTokens: z.number().int().min(100_000).max(1_000_000_000),
  burnWindowPct: z.number().min(1).max(100),
  errorLoopCount: z.number().int().min(3).max(100),
  autoStop: z.boolean(),
});
export type WatchdogThresholds = z.infer<typeof WatchdogThresholdsSchema>;

export const DEFAULT_WATCHDOG_THRESHOLDS: WatchdogThresholds = {
  waitingMinutes: 15,
  burnWeightedTokens: 5_000_000,
  burnWindowPct: 10,
  errorLoopCount: 5,
  autoStop: false,
};

export const WatchdogOverrideSchema = WatchdogThresholdsSchema.partial().strict();
export type WatchdogOverride = z.infer<typeof WatchdogOverrideSchema>;

const IdKeyedOverrides = z.record(z.uuid(), WatchdogOverrideSchema).refine((r) => Object.keys(r).length <= WATCHDOG_LIMITS.maxOverrides, 'too many overrides');

export const WatchdogSettingsSchema = z.object({
  enabled: z.boolean(),
  defaults: WatchdogThresholdsSchema,
  /** `projects.id` bo'yicha qisman qayta belgilash. */
  projects: IdKeyedOverrides,
  /** `sessions.id` bo'yicha qisman qayta belgilash (loyihadan ustun). */
  sessions: IdKeyedOverrides,
});
export type WatchdogSettings = z.infer<typeof WatchdogSettingsSchema>;

export const DEFAULT_WATCHDOG_SETTINGS: WatchdogSettings = { enabled: true, defaults: DEFAULT_WATCHDOG_THRESHOLDS, projects: {}, sessions: {} };

export const AlertDtoSchema = z.object({
  id: z.uuid(),
  kind: AlertKindSchema,
  state: AlertStateSchema,
  sessionId: z.uuid(),
  machineId: z.uuid(),
  projectId: z.uuid().nullable(),
  sessionName: z.string().nullable(),
  projectName: z.string().nullable(),
  title: z.string(),
  detail: z.string(),
  /** Faqat raqamlar/xesh (masalan `minutes`, `weighted10m`, `pct10m`, `count`, `hash`). */
  metrics: z.record(z.string(), z.union([z.number(), z.string(), z.null()])),
  remindersSent: z.number().int().min(0),
  autoStopped: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
  resolvedAt: z.string().nullable(),
});
export type AlertDto = z.infer<typeof AlertDtoSchema>;

export const ListAlertsQuerySchema = z.object({
  state: z.enum(['open', 'all']).default('open'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type ListAlertsQuery = z.infer<typeof ListAlertsQuerySchema>;
export const ListAlertsResponseSchema = z.object({ items: z.array(AlertDtoSchema) });
export type ListAlertsResponse = z.infer<typeof ListAlertsResponseSchema>;

export const AlertCreatedMessageSchema = envelopeMessage('alert.created', z.object({ alert: AlertDtoSchema }));
export const AlertUpdatedMessageSchema = envelopeMessage('alert.updated', z.object({ alert: AlertDtoSchema }));

/** agentd `agent.events` da yuboradigan xato-takrori belgisi: `notificationType` va `message` (`error_loop:<xesh>:<son>`). */
export const ERROR_LOOP_NOTIFICATION = 'error_loop';
export const ERROR_LOOP_EVENT = 'ErrorLoop';
export const ERROR_LOOP_AGENT_THRESHOLD = 5;

export function formatErrorLoopMessage(hash: string, count: number): string {
  return `${ERROR_LOOP_NOTIFICATION}:${hash}:${count}`;
}

/** `error_loop:<xesh>:<son>` -> qismlar; boshqa matn uchun null. */
export function parseErrorLoopMessage(message: string | null | undefined): { hash: string; count: number } | null {
  if (!message) return null;
  const m = /^error_loop:([0-9a-f]{8,32}):(\d{1,6})$/.exec(message);
  return m ? { hash: m[1]!, count: Number(m[2]) } : null;
}
