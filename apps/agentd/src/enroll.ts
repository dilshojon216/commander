import { arch, hostname, platform } from 'node:os';
import { existsSync } from 'node:fs';
import { EnrollResponseSchema } from '@commander/contracts';
import type { EnrollRequest } from '@commander/contracts';
import { ConfigSchema, loadConfig, saveConfig } from './config.js';
import { fingerprintOf } from './center-pin.js';
import { computeHardwareId, generateDeviceKey, removePrivateKey, storePrivateKey } from './identity.js';
import type { Logger } from './logger.js';
import type { AgentdPaths } from './paths.js';

export interface EnrollOptions {
  centerUrl: string;
  code: string;
  force?: boolean;
  claudeBin?: string;
  statuslineCommand?: string;
  fetchFn?: typeof fetch;
}

export interface EnrollResult {
  deviceId: string;
  machineId: string;
}

/** `https://` har doim; `http://` faqat loopback yoki tailnet (100.64.0.0/10, WireGuard ichida) uchun (L-23). */
export function isEnrollTransportSafe(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol === 'https:') return true;
  if (u.protocol !== 'http:') return false;
  const h = u.hostname.replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h === '::1' || /^127\./.test(h)) return true;
  const m = /^100\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(h);
  return m !== null && Number(m[1]) >= 64 && Number(m[1]) <= 127;
}

/**
 * Enrollment: Ed25519 kalit yaratadi, maxfiy kalitni `~/.commander/device.key` (0600) ga yozadi,
 * `POST /v1/enroll` (bir martalik kod + xom public key) chaqiradi va deviceId'ni config'ga saqlaydi.
 * Kalit va kod logga/xatoga chiqmaydi. Xato bo'lsa yangi yaratilgan kalit o'chiriladi.
 */
export async function enroll(paths: AgentdPaths, opts: EnrollOptions, log: Logger): Promise<EnrollResult> {
  const centerUrl = opts.centerUrl.replace(/\/+$/, '');
  if (!/^https?:\/\//.test(centerUrl)) throw new Error('--center to\'liq URL bo\'lishi kerak (https://...)');
  if (!isEnrollTransportSafe(centerUrl)) throw new Error("--center https:// bo'lishi kerak (enrollment kodi ochiq HTTP orqali yuborilmaydi; faqat loopback va tailnet 100.64/10 uchun http ruxsat)");

  if (existsSync(paths.keyFile) && !opts.force) {
    let existing = '';
    try {
      existing = loadConfig(paths).deviceId;
    } catch {
      /* config yo'q: kalit yetim qolgan */
    }
    throw new Error(
      existing
        ? `bu mashina allaqachon enroll qilingan (deviceId ${existing}); qayta enroll uchun avval markazda "device revoke", keyin --force`
        : `${paths.keyFile} mavjud; --force bilan ustidan yozing`,
    );
  }
  if (opts.force) removePrivateKey(paths);

  const key = generateDeviceKey();
  storePrivateKey(paths, key.privateKey);

  const body: EnrollRequest = {
    code: opts.code,
    public_key: key.publicKeyRaw,
    hardware_id: computeHardwareId(),
    hostname: hostname(),
    os: platform(),
    arch: arch(),
  };

  try {
    const res = await (opts.fetchFn ?? fetch)(`${centerUrl}/v1/enroll`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    if (res.status !== 201) {
      throw new Error(`enrollment rad etildi: HTTP ${res.status} ${text.slice(0, 200)}`);
    }
    const parsed = EnrollResponseSchema.parse(JSON.parse(text));
    saveConfig(
      paths,
      ConfigSchema.parse({
        centerUrl,
        deviceId: parsed.device_id,
        machineId: parsed.machine_id,
        enrolledAt: new Date().toISOString(),
        ...(parsed.center_public_key ? { centerKey: { publicKey: parsed.center_public_key, fingerprint: fingerprintOf(parsed.center_public_key), pinnedAt: new Date().toISOString(), via: 'enroll' as const } } : {}),
        ...(opts.claudeBin ? { claudeBin: opts.claudeBin } : {}),
        ...(opts.statuslineCommand ? { statuslineCommand: opts.statuslineCommand } : {}),
      }),
    );
    log.info('enrollment muvaffaqiyatli', { deviceId: parsed.device_id, machineId: parsed.machine_id });
    return { deviceId: parsed.device_id, machineId: parsed.machine_id };
  } catch (err) {
    removePrivateKey(paths);
    throw err;
  }
}
