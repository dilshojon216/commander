import type {
  AdminDeviceEntry,
  AdminEnrollCodeEntry,
  AdminTelegramEntry,
  AdminTelegramPendingEntry,
  AdminTokenEntry,
  AdminTokenState,
} from '@commander/contracts';

/**
 * N1.12: CLI `--json` chiqishlarining sof xaritalari (DB qatori -> `libs/contracts/src/admin-cli.ts` shakli). Sirlar bu yerga
 * KIRMAYDI: kirish tiplari tokenHash/publicKey/kod maydonlarini umuman o'z ichiga olmaydi (yalang'och `Pick` emas, aniq tur).
 */

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

export interface EnrollCodeRow {
  id: string;
  machine_name: string;
  expires_at: Date;
  used_at: Date | null;
  created_at: Date;
}

export function enrollCodeEntry(r: EnrollCodeRow, now: number = Date.now()): AdminEnrollCodeEntry {
  const state = r.used_at ? 'used' : r.expires_at.getTime() <= now ? 'expired' : 'pending';
  return { id: r.id, machineName: r.machine_name, state, createdAt: r.created_at.toISOString(), expiresAt: r.expires_at.toISOString(), usedAt: iso(r.used_at) };
}

export interface DeviceRowLike {
  id: string;
  machineId: string | null;
  name: string | null;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  expiresAt?: Date | null;
  rotationRequired: boolean;
  keyRotatedAt: Date | null;
}

export interface TokenRowLike {
  id: string;
  kind: string;
  name: string | null;
  scopes: string[];
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  expiresAt: Date | null;
}

export function tokenState(d: Pick<TokenRowLike, 'revokedAt' | 'expiresAt'>, now: number = Date.now()): AdminTokenState {
  if (d.revokedAt) return 'revoked';
  return d.expiresAt && d.expiresAt.getTime() <= now ? 'expired' : 'active';
}

export function tokenEntry(d: TokenRowLike, now: number = Date.now()): AdminTokenEntry {
  return {
    id: d.id,
    kind: d.kind,
    name: d.name,
    scopes: [...d.scopes],
    state: tokenState(d, now),
    createdAt: d.createdAt.toISOString(),
    lastUsedAt: iso(d.lastUsedAt),
    expiresAt: iso(d.expiresAt),
    revokedAt: iso(d.revokedAt),
  };
}

export function deviceEntry(d: DeviceRowLike): AdminDeviceEntry {
  return {
    id: d.id,
    machineId: d.machineId,
    name: d.name,
    state: d.revokedAt ? 'revoked' : 'active',
    createdAt: d.createdAt.toISOString(),
    lastUsedAt: iso(d.lastUsedAt),
    revokedAt: iso(d.revokedAt),
    rotationRequired: d.rotationRequired,
    keyRotatedAt: iso(d.keyRotatedAt),
  };
}

export function telegramEntries(envIds: readonly string[], dbIds: readonly string[]): AdminTelegramEntry[] {
  return [...envIds.map((chatId) => ({ chatId, source: 'env' as const })), ...dbIds.map((chatId) => ({ chatId, source: 'db' as const }))];
}

export function telegramPendingEntry(p: { chatId: string; username: string | null; name: string | null; at: number }): AdminTelegramPendingEntry {
  return { chatId: p.chatId, username: p.username, name: p.name, atMs: p.at };
}
