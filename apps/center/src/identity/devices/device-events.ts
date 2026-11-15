import type { DataSource, EntityManager } from 'typeorm';

/** Postgres LISTEN/NOTIFY kanali: CLI (alohida jarayon) va center server o'rtasidagi "darhol" signal (5.1). */
export const DEVICE_EVENTS_CHANNEL = 'commander_device_events';

export type DeviceEventKind = 'revoked' | 'rotation_required' | 'center_key_rotated';

export interface ParsedDeviceEvent {
  kind: DeviceEventKind;
  /** `center_key_rotated` uchun null. */
  deviceId: string | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `kind:uuid` (yoki `center_key_rotated`). Noto'g'ri yuk (begona NOTIFY) `null`: e'tiborsiz. */
export function parseDeviceEvent(payload: string | undefined): ParsedDeviceEvent | null {
  if (!payload) return null;
  if (payload === 'center_key_rotated') return { kind: 'center_key_rotated', deviceId: null };
  const [kind, id, ...rest] = payload.split(':');
  if (rest.length > 0 || !id || !UUID_RE.test(id)) return null;
  if (kind !== 'revoked' && kind !== 'rotation_required') return null;
  return { kind, deviceId: id.toLowerCase() };
}

export const formatDeviceEvent = (kind: DeviceEventKind, deviceId?: string): string => (kind === 'center_key_rotated' ? kind : `${kind}:${deviceId ?? ''}`);

/** `pg_notify`: tranzaksiya ichida chaqirilsa COMMIT'dan keyin yetkaziladi. */
export async function notifyDeviceEvent(runner: DataSource | EntityManager, kind: DeviceEventKind, deviceId?: string): Promise<void> {
  await runner.query(`SELECT pg_notify($1, $2)`, [DEVICE_EVENTS_CHANNEL, formatDeviceEvent(kind, deviceId)]);
}
