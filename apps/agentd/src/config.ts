import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import type { AgentdPaths } from './paths.js';

export const DEFAULT_OTLP_PORT = 4319;

export const ConfigSchema = z.object({
  /** `https://<mac>.<tailnet>.ts.net` (enrollment va WS shu manzildan). */
  centerUrl: z.url(),
  deviceId: z.uuid(),
  machineId: z.uuid().optional(),
  enrolledAt: z.string().optional(),
  /** `claude` binarining yo'li (launchd/systemd PATH'i minimal bo'lgani uchun). */
  claudeBin: z.string().min(1).default('claude'),
  otlpPort: z.number().int().min(1).max(65535).default(DEFAULT_OTLP_PORT),
  /** `true`: OTLP so'rovlari `x-commander-token` sarlavhasiz rad etiladi (M-20). Sukut `false`: bir release moslik (ogohlantirish + hisoblagich). */
  otlpRequireToken: z.boolean().default(false),
  /** Qo'shimcha loyiha ildizlari (project-reporter): sessiya ko'rinmagan papkalar ham kuzatiladi (task 2.1). */
  projectRoots: z.array(z.string().min(1).max(4096)).max(200).default([]),
  /** Sessiya xulosalari (6.1): `false` = bu mashinada xulosa yaratilmaydi (lokal o'chirish; markaz sozlamalaridan alohida). */
  summaries: z.boolean().default(true),
  /** `cc-statusline` o'rab oladigan foydalanuvchining joriy status line buyrug'i. */
  statuslineCommand: z.string().optional(),
  /**
   * PIN qilingan markaz buyruq-imzo kaliti (xom 32 bayt Ed25519, base64url). Enrollment'da (center javobi) yoki eski
   * agentlar uchun birinchi `auth.ok`da (TOFU) o'rnatiladi; keyin FAQAT `agentd center-key reset` bilan (lokal) o'zgaradi.
   */
  centerKey: z.object({ publicKey: z.string().regex(/^[A-Za-z0-9_-]{43}$/), fingerprint: z.string(), pinnedAt: z.string(), via: z.enum(['enroll', 'tofu', 'manual', 'rotation']) }).optional(),
});
export type AgentdConfig = z.infer<typeof ConfigSchema>;

/** Windows'da `mode`/`chmod` deyarli ishlamaydi (faqat read-only bit): himoya foydalanuvchi profili ACL'iga tayanadi. */
export function ensureHomeDir(paths: AgentdPaths): void {
  mkdirSync(paths.home, { recursive: true, mode: 0o700 });
  chmodSync(paths.home, 0o700);
}

export function loadConfig(paths: AgentdPaths): AgentdConfig {
  let raw: string;
  try {
    raw = readFileSync(paths.configFile, 'utf8');
  } catch {
    throw new Error(`config topilmadi (${paths.configFile}); avval "agentd enroll --center <url> --code <kod>" ni ishga tushiring`);
  }
  const parsed = ConfigSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) throw new Error(`config yaroqsiz: ${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

export function saveConfig(paths: AgentdPaths, config: AgentdConfig): void {
  ensureHomeDir(paths);
  const tmp = `${paths.configFile}.tmp`;
  writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, paths.configFile);
}

/** `https://x` -> `wss://x/ws/agent`, `http://x` -> `ws://x/ws/agent`. */
export function toWsUrl(centerUrl: string, wsPath: string): string {
  const u = new URL(centerUrl);
  u.protocol = u.protocol === 'http:' ? 'ws:' : 'wss:';
  u.pathname = wsPath;
  u.search = '';
  u.hash = '';
  return u.toString();
}
