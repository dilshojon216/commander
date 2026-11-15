import { createHash } from 'node:crypto';
import { CONFIG_LIMITS, SettingsFragmentSchema, checkConfigPath, checkSettingsFragment, configPathKey, normalizeSettingsFragment } from '@commander/contracts';
import type { ConfigCaptureResult, ConfigItem, ConfigSkipped, SettingsFragment } from '@commander/contracts';
import { canonicalJson } from '@commander/contracts';
import type { BundleContent } from './config-bundle.js';

export const sha256Hex = (s: string | Buffer): string => createHash('sha256').update(s).digest('hex');
export const fragmentSha256 = (f: SettingsFragment): string => sha256Hex(canonicalJson(normalizeSettingsFragment(f)));

export interface ValidatedCapture {
  files: Array<ConfigItem & { content: string }>;
  settings: SettingsFragment | null;
  skipped: ConfigSkipped[];
  totalBytes: number;
}

/**
 * Agentdan kelgan capture natijasini markazda QAYTA tekshiradi (xavfsizlik to'ri): yo'l ruxsat ro'yxati, xesh/hajm mosligi,
 * sirlar (sirli fayl tashlanadi va `skipped` ga yoziladi), bo'lak (settings) sxemasi va qoidalari. Mazmun/xesh nomuvofiqligi
 * butun capture'ni yaroqsiz qiladi (`error`).
 */
export function validateCapture(res: ConfigCaptureResult, bundle: BundleContent | null, looksSecret: (t: string) => boolean): { ok: true; value: ValidatedCapture } | { ok: false; error: string } {
  const skipped: ConfigSkipped[] = [...res.skipped];
  const byPath = new Map((bundle?.files ?? []).map((f) => [f.path, f.content]));
  if (byPath.size !== (bundle?.files.length ?? 0)) return { ok: false, error: 'duplicate paths in bundle' };
  const files: ValidatedCapture['files'] = [];
  const seen = new Set<string>();
  let total = 0;
  for (const it of res.items) {
    const chk = checkConfigPath(it.path);
    if (!chk.ok || chk.kind !== it.kind) return { ok: false, error: `path not allowed: ${it.path.slice(0, 80)}` };
    const key = configPathKey(it.path);
    if (seen.has(key)) return { ok: false, error: 'paths differ only by case' };
    seen.add(key);
    const content = byPath.get(it.path);
    if (content === undefined) return { ok: false, error: `content missing for ${it.path.slice(0, 80)}` };
    const buf = Buffer.from(content, 'utf8');
    if (buf.length !== it.size || buf.length > CONFIG_LIMITS.fileMaxBytes || sha256Hex(buf) !== it.sha256) return { ok: false, error: `hash/size mismatch for ${it.path.slice(0, 80)}` };
    if (looksSecret(content)) {
      skipped.push({ path: it.path, reason: 'contains a secret (center check): refused' });
      continue;
    }
    if (total + buf.length > CONFIG_LIMITS.profileMaxBytes) {
      skipped.push({ path: it.path, reason: 'profile size limit (5 MB) reached' });
      continue;
    }
    total += buf.length;
    files.push({ ...it, content });
  }
  if (byPath.size !== res.items.length) return { ok: false, error: 'bundle has files that are not listed' };

  let settings: SettingsFragment | null = null;
  if (res.settingsSha256 !== null) {
    const parsed = SettingsFragmentSchema.safeParse(bundle?.settings);
    if (!parsed.success) return { ok: false, error: 'settings fragment is invalid' };
    const frag = normalizeSettingsFragment(parsed.data);
    if (fragmentSha256(frag) !== res.settingsSha256) return { ok: false, error: 'settings fragment hash mismatch' };
    const problems = checkSettingsFragment(frag, looksSecret);
    if (problems.length > 0) {
      for (const p of problems.slice(0, 20)) skipped.push({ path: 'settings.json', reason: `${p.where}: ${p.reason}` });
    } else {
      settings = frag;
    }
  } else if (bundle?.settings) {
    return { ok: false, error: 'unexpected settings fragment' };
  }
  return { ok: true, value: { files, settings, skipped: skipped.slice(0, CONFIG_LIMITS.maxSkipped), totalBytes: total } };
}
