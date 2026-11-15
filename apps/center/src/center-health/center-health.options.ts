import type { ConfigService } from '@nestjs/config';
import { createProbes } from './center-probes.js';
import type { CenterProbes } from './center-probes.js';

export const CENTER_HEALTH_OPTIONS = Symbol('CENTER_HEALTH_OPTIONS');
export const CENTER_PROBES = Symbol('CENTER_PROBES');

export interface CenterHealthOptions {
  enabled: boolean;
  tickMs: number;
  /** Birinchi tekshiruv kechikishi (ishga tushish paytidagi vaqtinchalik holatlar hodisa bo'lib qolmasin). */
  firstTickMs: number;
}

const str = (c: ConfigService, k: string): string | null => {
  const v = (c.get<string>(k) ?? '').trim();
  return v || null;
};

export function centerHealthOptionsFromConfig(config: ConfigService): CenterHealthOptions {
  // Testlar (vitest) doimiy taymer ishga tushirmasin; qo'lda `CENTER_HEALTH_DISABLED=1` ham o'chiradi.
  const disabled = !!process.env['VITEST'] || ['1', 'true'].includes((config.get<string>('CENTER_HEALTH_DISABLED') ?? '').toLowerCase());
  return { enabled: !disabled, tickMs: 60_000, firstTickMs: 45_000 };
}

export function centerProbesFromConfig(config: ConfigService): CenterProbes {
  const publicUrl = str(config, 'CENTER_PUBLIC_URL');
  const tailscale = str(config, 'TAILSCALE_PROBE_URL') ?? (publicUrl ? `${publicUrl.replace(/\/+$/, '')}/health` : null);
  return createProbes({
    diskPath: str(config, 'CENTER_DISK_PATH') ?? '/var/lib/commander-secrets',
    dashboardUrl: str(config, 'DASHBOARD_PROBE_URL'),
    tailscaleUrl: tailscale,
    timeoutMs: 5_000,
  });
}
