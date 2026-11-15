import { ConfigService } from '@nestjs/config';

export const ORCH_OPTIONS = Symbol('ORCH_OPTIONS');

export interface OrchOptions {
  /** Fon tik (byudjet, tugagan sessiyalar, navbat elementlari). 0 = o'chiq (testlar). */
  tickMs: number;
}

export const DEFAULT_ORCH_OPTIONS: OrchOptions = { tickMs: 30_000 };

export function orchOptionsFromConfig(config: ConfigService): OrchOptions {
  const tick = Number(config.get<string>('ORCH_TICK_MS') ?? DEFAULT_ORCH_OPTIONS.tickMs);
  return { tickMs: Number.isFinite(tick) && tick >= 0 ? tick : DEFAULT_ORCH_OPTIONS.tickMs };
}
