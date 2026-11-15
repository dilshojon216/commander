import { DEFAULT_PACE_SETTINGS, PaceSettingsSchema } from '@commander/contracts';
import type { PaceSettings } from '@commander/contracts';
import type { DataSource, EntityManager } from 'typeorm';
import { tashkentDayOf } from '../projects/tashkent-day.js';

/** `settings` jadvali kalitlari (migratsiya kerak emas: key/value jsonb). */
export const PACE_SETTINGS_KEY = 'limits.pace';
export const PACE_OVERRIDE_KEY = 'limits.pace_override';

type Q = Pick<DataSource | EntityManager, 'query'>;

/** Sozlamalar (yaroqsiz/yo'q bo'lsa default). */
export async function loadPaceState(q: Q, now: Date): Promise<{ settings: PaceSettings; overriddenToday: boolean; day: string }> {
  const rows: Array<{ key: string; value: unknown }> = await q.query(`SELECT key, value FROM settings WHERE key = ANY($1::text[])`, [[PACE_SETTINGS_KEY, PACE_OVERRIDE_KEY]]);
  const get = (k: string): unknown => rows.find((r) => r.key === k)?.value;
  const parsed = PaceSettingsSchema.safeParse({ ...DEFAULT_PACE_SETTINGS, ...(typeof get(PACE_SETTINGS_KEY) === 'object' && get(PACE_SETTINGS_KEY) !== null ? (get(PACE_SETTINGS_KEY) as object) : {}) });
  const day = tashkentDayOf(now);
  const ov = get(PACE_OVERRIDE_KEY);
  const overriddenToday = typeof ov === 'object' && ov !== null && (ov as { day?: unknown }).day === day;
  return { settings: parsed.success && parsed.data.softPct < parsed.data.hardPct ? parsed.data : DEFAULT_PACE_SETTINGS, overriddenToday, day };
}
