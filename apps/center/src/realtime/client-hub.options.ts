import { CLIENT_LIMITS } from '@commander/contracts';

export interface ClientHubOptions {
  /** Revoke/lockdown tekshiruvi oralig'i. */
  sweepMs: number;
  usageTickMs: number;
  authTimeoutMs: number;
}

export const CLIENT_HUB_OPTIONS = Symbol('CLIENT_HUB_OPTIONS');

export const DEFAULT_CLIENT_HUB_OPTIONS: ClientHubOptions = {
  sweepMs: 5_000,
  usageTickMs: CLIENT_LIMITS.usageTickMs,
  authTimeoutMs: CLIENT_LIMITS.authTimeoutMs,
};
