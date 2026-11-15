import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { DEFAULT_HEALTH_THRESHOLDS, HealthThresholdsPatchSchema, HealthThresholdsSchema } from '@commander/contracts';
import type { HealthThresholds, HealthThresholdsPatch, HealthThresholdsResponse, PutHealthThresholdsBody } from '@commander/contracts';
import { z } from 'zod';

export const THRESHOLDS_SETTING_KEY = 'health.thresholds';
const CACHE_MS = 30_000;

const StoredSchema = z.object({
  defaults: HealthThresholdsPatchSchema.default({}),
  machines: z.record(z.uuid(), HealthThresholdsPatchSchema).default({}),
});
type Stored = z.infer<typeof StoredSchema>;

/** Patch'ni birlashtirgandan keyin mantiq: kritik chegara ogohlantirishdan past bo'lmasin. */
export function resolveThresholds(stored: Stored, machineId: string | null): HealthThresholds {
  const merged = { ...DEFAULT_HEALTH_THRESHOLDS, ...stored.defaults, ...(machineId ? (stored.machines[machineId] ?? {}) : {}) };
  const parsed = HealthThresholdsSchema.safeParse(merged);
  const t = parsed.success ? parsed.data : DEFAULT_HEALTH_THRESHOLDS;
  return t.diskCriticalPct < t.diskWarnPct ? { ...t, diskCriticalPct: t.diskWarnPct } : t;
}

/** Chegaralar `settings` jadvalida (`health.thresholds`): global sukut + mashina bo'yicha override. 30 s kesh. */
@Injectable()
export class HealthThresholdsService {
  private cache: { at: number; stored: Stored } | null = null;

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  private async load(now = Date.now()): Promise<Stored> {
    if (this.cache && now - this.cache.at < CACHE_MS) return this.cache.stored;
    const rows: Array<{ value: unknown }> = await this.dataSource.query(`SELECT value FROM settings WHERE key = $1`, [THRESHOLDS_SETTING_KEY]);
    const parsed = StoredSchema.safeParse(rows[0]?.value ?? {});
    const stored = parsed.success ? parsed.data : { defaults: {}, machines: {} };
    this.cache = { at: now, stored };
    return stored;
  }

  async forMachine(machineId: string): Promise<HealthThresholds> {
    return resolveThresholds(await this.load(), machineId);
  }

  async get(): Promise<HealthThresholdsResponse> {
    const s = await this.load();
    return { defaults: resolveThresholds(s, null), machines: s.machines };
  }

  /** `defaults` patch'i mavjud sukutga qo'shiladi; `machines[id] = null` override'ni o'chiradi. */
  async put(body: PutHealthThresholdsBody): Promise<HealthThresholdsResponse> {
    const cur = await this.load(0);
    const defaults: HealthThresholdsPatch = { ...cur.defaults, ...(body.defaults ?? {}) };
    const machines: Record<string, HealthThresholdsPatch> = { ...cur.machines };
    for (const [id, patch] of Object.entries(body.machines ?? {})) {
      if (patch === null) delete machines[id];
      else machines[id] = { ...(machines[id] ?? {}), ...patch };
    }
    const value: Stored = { defaults, machines };
    await this.dataSource.query(
      `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2::jsonb, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [THRESHOLDS_SETTING_KEY, JSON.stringify(value)],
    );
    this.cache = null;
    return this.get();
  }
}
