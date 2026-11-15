import { createHash } from 'node:crypto';
import { canonicalJson, checkSettingsFragment, allowEntryProblem, envKeyProblem, normalizeSettingsFragment, SettingsFragmentSchema } from '@commander/contracts';
import type { ConfigMode, ConfigSettingsPlan, SettingsFragment } from '@commander/contracts';

/**
 * `settings.json` bo'lagini chiqarish va birlashtirish (3.7). FAQAT `permissions.allow|deny` va `env` ga tegiladi:
 * `hooks` (Commander'niki ham), `statusLine`, `permissions.defaultMode`, boshqa env'lar va qolgan hamma kalit o'zgarishsiz qoladi
 * (invariant `assertOnlyManagedKeysChanged` bilan tekshiriladi: buzilsa yozilmaydi).
 */

type Json = Record<string, unknown>;

export const settingsSha256 = (f: SettingsFragment): string => createHash('sha256').update(canonicalJson(normalizeSettingsFragment(f)), 'utf8').digest('hex');

/** Lokal manifestda saqlanadigan, Commander joylashtirgan bo'lak holati. */
export interface ManagedSettings {
  fragment: SettingsFragment;
  /** Commander O'ZI qo'shgan yozuvlar (mirror faqat shularni olib tashlay oladi). */
  ownedAllow: string[];
  ownedDeny: string[];
  ownedEnv: string[];
  /** Commander qo'ygan env qiymatlari (mirror: lokal qiymat shunga teng bo'lsagina o'chiradi). */
  envDeployed: Record<string, string>;
  sha256: string;
}

const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const strArray = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

export interface ExtractedSettings {
  fragment: SettingsFragment;
  /** Rad etilgan yozuvlar (qiymatsiz, faqat o'rni va sababi). */
  skipped: string[];
}

/** Lokal settings.json'dan profilga kiradigan bo'lakni oladi; sirli/keng/himoyalangan yozuvlar tashlanadi va ro'yxatga yoziladi. */
export function extractSettingsFragment(settings: unknown, looksSecret: (t: string) => boolean): ExtractedSettings {
  const skipped: string[] = [];
  const allow: string[] = [];
  const deny: string[] = [];
  const env: Record<string, string> = {};
  const root = isObj(settings) ? settings : {};
  const perms = isObj(root['permissions']) ? root['permissions'] : {};
  const entryOk = (e: string): boolean => e.length >= 1 && e.length <= 300 && !/[\u0000-\u001f\u007f]/.test(e);

  for (const [i, e] of strArray(perms['allow']).entries()) {
    const p = !entryOk(e) ? 'invalid entry' : allowEntryProblem(e) ?? (looksSecret(e) ? 'entry looks like it contains a secret' : null);
    if (p) skipped.push(`permissions.allow[${i}]: ${p}`);
    else allow.push(e);
  }
  for (const [i, e] of strArray(perms['deny']).entries()) {
    const p = !entryOk(e) ? 'invalid entry' : looksSecret(e) ? 'entry looks like it contains a secret' : null;
    if (p) skipped.push(`permissions.deny[${i}]: ${p}`);
    else deny.push(e);
  }
  const rawEnv = isObj(root['env']) ? root['env'] : {};
  for (const [k, v] of Object.entries(rawEnv)) {
    const kp = envKeyProblem(k);
    if (kp) {
      skipped.push(`env.${k.slice(0, 64)}: ${kp}`);
      continue;
    }
    if (typeof v !== 'string' || v.length > 512 || /[\u0000-\u001f\u007f]/.test(v)) {
      skipped.push(`env.${k}: value is not a short plain string`);
      continue;
    }
    if (looksSecret(v) || looksSecret(`${k}=${v}`)) {
      skipped.push(`env.${k}: value looks like a secret`);
      continue;
    }
    env[k] = v;
  }
  return { fragment: normalizeSettingsFragment({ permissions: { allow: allow.slice(0, 200), deny: deny.slice(0, 200) }, env }), skipped: skipped.slice(0, 50) };
}

const KEEP = new Set(['permissions', 'env']);

/** Invariant: `permissions.allow|deny` va `env` dan boshqa hamma narsa (jumladan `hooks`) bayt-bayt bir xil. */
export function assertOnlyManagedKeysChanged(before: Json, after: Json): void {
  const strip = (o: Json): Json => {
    const c: Json = { ...o };
    for (const k of KEEP) delete c[k];
    if (isObj(o['permissions'])) {
      const { allow: _a, deny: _d, ...rest } = o['permissions'];
      if (Object.keys(rest).length > 0) c['permissions'] = rest;
    }
    return c;
  };
  if (canonicalJson(strip(before)) !== canonicalJson(strip(after))) throw new Error('settings merge would change keys outside the managed set');
  // `permissions` ichidagi boshqa kalitlar (defaultMode va h.k.) ham o'zgarmasin: strip ularni qoldiradi va solishtiradi.
}

export interface SettingsPlanInput {
  fragment: SettingsFragment;
  /** Lokal settings.json (parse qilingan); `undefined` = fayl yo'q. */
  local: unknown;
  /** Lokal fayl o'qilmadi/yaroqsiz JSON (yozilmaydi). */
  localInvalid?: boolean;
  prev: ManagedSettings | null;
  mode: ConfigMode;
  looksSecret: (t: string) => boolean;
}

export interface SettingsPlanOutput {
  plan: ConfigSettingsPlan;
  /** Yangi to'liq settings.json obyekti; `null` = yozilmaydi (o'zgarish yo'q yoki rad). */
  next: Json | null;
  managed: ManagedSettings | null;
}

const EMPTY_PLAN: Omit<ConfigSettingsPlan, 'refused'> = { changed: false, allowAdd: [], allowRemove: [], denyAdd: [], denyRemove: [], envSet: [], envRemove: [] };

export function planSettings(i: SettingsPlanInput): SettingsPlanOutput {
  const parsed = SettingsFragmentSchema.safeParse(i.fragment);
  const problems = parsed.success ? checkSettingsFragment(parsed.data, i.looksSecret).map((p) => `${p.where}: ${p.reason}`) : ['fragment has an invalid shape'];
  if (i.localInvalid) problems.push('local settings.json is not valid JSON: not touched');
  if (i.local !== undefined && !isObj(i.local)) problems.push('local settings.json is not an object: not touched');
  if (problems.length > 0 || !parsed.success) return { plan: { ...EMPTY_PLAN, refused: problems.slice(0, 50) }, next: null, managed: i.prev };

  const frag = normalizeSettingsFragment(parsed.data);
  const local: Json = isObj(i.local) ? i.local : {};
  const localPerms = isObj(local['permissions']) ? local['permissions'] : {};
  const localAllow = strArray(localPerms['allow']);
  const localDeny = strArray(localPerms['deny']);
  const localEnv: Record<string, unknown> = isObj(local['env']) ? local['env'] : {};

  const allowAdd = frag.permissions.allow.filter((e) => !localAllow.includes(e));
  const denyAdd = frag.permissions.deny.filter((e) => !localDeny.includes(e));
  const envSet = Object.entries(frag.env).filter(([k, v]) => localEnv[k] !== v);

  const prev = i.prev;
  let allowRemove: string[] = [];
  let denyRemove: string[] = [];
  let envRemove: string[] = [];
  if (i.mode === 'mirror' && prev) {
    allowRemove = prev.ownedAllow.filter((e) => !frag.permissions.allow.includes(e) && localAllow.includes(e));
    denyRemove = prev.ownedDeny.filter((e) => !frag.permissions.deny.includes(e) && localDeny.includes(e));
    envRemove = prev.ownedEnv.filter((k) => !(k in frag.env) && localEnv[k] !== undefined && localEnv[k] === prev.envDeployed[k]);
  }

  const changed = allowAdd.length + denyAdd.length + envSet.length + allowRemove.length + denyRemove.length + envRemove.length > 0;

  // Egalik: yangi qo'shilganlar + oldingi egalik (mirror: o'chirilganlar chiqadi)
  const own = (prevList: string[] | undefined, added: string[], removed: string[]): string[] => [...new Set([...(prevList ?? []).filter((e) => !removed.includes(e)), ...added])].sort();
  const ownedEnv = [...new Set([...(prev?.ownedEnv ?? []).filter((k) => !envRemove.includes(k)), ...envSet.map(([k]) => k)])].sort();
  const envDeployed: Record<string, string> = {};
  for (const k of ownedEnv) {
    const v = frag.env[k] ?? prev?.envDeployed[k];
    if (v !== undefined) envDeployed[k] = v;
  }
  const managed: ManagedSettings = {
    fragment: frag,
    ownedAllow: own(prev?.ownedAllow, allowAdd, allowRemove),
    ownedDeny: own(prev?.ownedDeny, denyAdd, denyRemove),
    ownedEnv,
    envDeployed,
    sha256: settingsSha256(frag),
  };
  const plan: ConfigSettingsPlan = {
    changed,
    allowAdd,
    allowRemove,
    denyAdd,
    denyRemove,
    envSet: envSet.map(([k, v]) => `${k}=${v}`),
    envRemove,
    refused: [],
  };
  if (!changed) return { plan, next: null, managed };

  const next: Json = structuredClone(local);
  const nextPerms: Json = isObj(next['permissions']) ? (next['permissions'] as Json) : {};
  if (allowAdd.length > 0 || allowRemove.length > 0) nextPerms['allow'] = [...strArray(nextPerms['allow']).filter((e) => !allowRemove.includes(e)), ...allowAdd];
  if (denyAdd.length > 0 || denyRemove.length > 0) nextPerms['deny'] = [...strArray(nextPerms['deny']).filter((e) => !denyRemove.includes(e)), ...denyAdd];
  if (Object.keys(nextPerms).length > 0) next['permissions'] = nextPerms;
  if (envSet.length > 0 || envRemove.length > 0) {
    const nextEnv: Json = isObj(next['env']) ? (next['env'] as Json) : {};
    for (const k of envRemove) delete nextEnv[k];
    for (const [k, v] of envSet) nextEnv[k] = v;
    next['env'] = nextEnv;
  }
  assertOnlyManagedKeysChanged(local, next);
  return { plan, next, managed };
}

/** Joylashtirilgan bo'lak lokal faylda hamon bormi (drift hisoboti). */
export function settingsIntact(m: ManagedSettings, local: unknown): boolean {
  if (!isObj(local)) return false;
  const perms = isObj(local['permissions']) ? local['permissions'] : {};
  const allow = strArray(perms['allow']);
  const deny = strArray(perms['deny']);
  const env: Record<string, unknown> = isObj(local['env']) ? local['env'] : {};
  return m.fragment.permissions.allow.every((e) => allow.includes(e)) && m.fragment.permissions.deny.every((e) => deny.includes(e)) && Object.entries(m.fragment.env).every(([k, v]) => env[k] === v);
}
