import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { CONFIG_LIMITS, ConfigBundleRefSchema, SettingsFragmentSchema } from '@commander/contracts';
import type { ConfigBundleRef, ConfigChunkPayload, SettingsFragment } from '@commander/contracts';
import { z } from 'zod';

/**
 * Profil "bundle"i: `{files:[{path,content}], settings}` JSON -> gzip -> `config.chunk` bo'laklari (base64). Xesh bo'laklar
 * orqali yaxlitlikni tekshiradi; gzip ochish hajmi cheklangan (zip-bomb himoyasi).
 */

export interface BundleContent {
  files: Array<{ path: string; content: string }>;
  settings: SettingsFragment | null;
}

const BundleSchema = z.object({
  files: z.array(z.object({ path: z.string(), content: z.string() })).max(CONFIG_LIMITS.maxFiles),
  settings: SettingsFragmentSchema.nullable(),
});

/** gzip ochilgandagi eng katta hajm: profil chegarasi + JSON qochirish va qo'shimcha sarlavhalar uchun zaxira. */
const MAX_INFLATED = CONFIG_LIMITS.profileMaxBytes * 2 + 256 * 1024;

export function encodeBundle(b: BundleContent): { ref: ConfigBundleRef; chunks: ConfigChunkPayload[] } {
  const gz = gzipSync(Buffer.from(JSON.stringify(b), 'utf8'), { level: 9 });
  const sha256 = createHash('sha256').update(gz).digest('hex');
  const total = Math.max(1, Math.ceil(gz.length / CONFIG_LIMITS.chunkRawBytes));
  if (total > CONFIG_LIMITS.maxChunks) throw new Error('bundle too large for transport');
  const chunks: ConfigChunkPayload[] = [];
  for (let i = 0; i < total; i++) {
    chunks.push({ transferId: sha256, seq: i, total, data: gz.subarray(i * CONFIG_LIMITS.chunkRawBytes, (i + 1) * CONFIG_LIMITS.chunkRawBytes).toString('base64') });
  }
  return { ref: { chunks: total, sha256, bytes: gz.length }, chunks };
}

export type DecodeResult = { ok: true; bundle: BundleContent } | { ok: false; reason: string };

/** To'liq base64 bo'laklar + ref (imzolangan payload ichida) -> bundle. */
export function decodeBundle(parts: string[], ref: ConfigBundleRef): DecodeResult {
  const parsedRef = ConfigBundleRefSchema.safeParse(ref);
  if (!parsedRef.success || parts.length !== ref.chunks) return { ok: false, reason: 'bundle reference mismatch' };
  const gz = Buffer.concat(parts.map((p) => Buffer.from(p, 'base64')));
  if (gz.length !== ref.bytes) return { ok: false, reason: 'bundle size mismatch' };
  if (createHash('sha256').update(gz).digest('hex') !== ref.sha256) return { ok: false, reason: 'bundle hash mismatch' };
  let raw: Buffer;
  try {
    raw = gunzipSync(gz, { maxOutputLength: MAX_INFLATED });
  } catch {
    return { ok: false, reason: 'bundle is not valid gzip or is too large' };
  }
  let json: unknown;
  try {
    json = JSON.parse(raw.toString('utf8'));
  } catch {
    return { ok: false, reason: 'bundle is not valid JSON' };
  }
  const p = BundleSchema.safeParse(json);
  return p.success ? { ok: true, bundle: p.data } : { ok: false, reason: 'bundle has an invalid shape' };
}
