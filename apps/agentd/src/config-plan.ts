import { createHash } from 'node:crypto';
import { canonicalJson, checkConfigPath } from '@commander/contracts';
import type { ConfigItemKind, ConfigMode, ConfigPlanAction, ConfigSettingsPlan } from '@commander/contracts';
import type { LocalState } from './config-fs.js';

/** Lokal manifest fayllari: Commander joylashtirgan (yoki tan olgan) fayllar. */
export interface ManifestFile {
  sha256: string;
  exec: boolean;
  /** Commander O'ZI yozgan (add/update). Faqat shular mirror'da o'chirilishi mumkin. */
  owned: boolean;
}
export type ManifestFiles = Record<string, ManifestFile>;

export interface PlanItem {
  path: string;
  kind: ConfigItemKind;
  sha256: string;
  exec: boolean;
}

export interface PlannedEntry {
  path: string;
  kind: ConfigItemKind;
  action: ConfigPlanAction;
  reason?: string;
  newSha?: string;
  localSha?: string;
  exec: boolean;
}

/**
 * Fayllar rejasi (sof). `merge`: profil fayllari qo'shiladi/yangilanadi, hech narsa o'chirilmaydi. `mirror`: qo'shimcha ravishda
 * oldin Commander joylashtirgan (`owned`) va hozir profilda yo'q fayllar o'chiriladi, lekin faqat lokal o'zgartirilmagan bo'lsa;
 * manifestda yo'q (foydalanuvchining o'z) fayllariga HECH QACHON tegilmaydi.
 */
export function planFiles(items: PlanItem[], local: (rel: string) => LocalState, manifest: ManifestFiles, mode: ConfigMode): PlannedEntry[] {
  const out: PlannedEntry[] = [];
  const inProfile = new Set<string>();
  for (const it of items) {
    inProfile.add(it.path);
    const st = local(it.path);
    if (st.state === 'unsafe') out.push({ path: it.path, kind: it.kind, action: 'skip', reason: st.reason, newSha: it.sha256, exec: it.exec });
    else if (st.state === 'missing') out.push({ path: it.path, kind: it.kind, action: 'add', newSha: it.sha256, exec: it.exec });
    else if (st.sha256 === it.sha256) out.push({ path: it.path, kind: it.kind, action: 'unchanged', newSha: it.sha256, localSha: st.sha256, exec: it.exec });
    else out.push({ path: it.path, kind: it.kind, action: 'update', newSha: it.sha256, localSha: st.sha256, exec: it.exec });
  }
  if (mode === 'mirror') {
    for (const [p, m] of Object.entries(manifest)) {
      if (!m.owned || inProfile.has(p)) continue;
      const c = checkConfigPath(p);
      if (!c.ok) continue; // manifest buzilgan/qo'lda o'zgartirilgan: ruxsat ro'yxatidan tashqari yo'lga tegmaymiz
      const st = local(p);
      if (st.state === 'missing') continue;
      if (st.state === 'unsafe') out.push({ path: p, kind: c.kind, action: 'skip', reason: st.reason, exec: false });
      else if (st.sha256 === m.sha256) out.push({ path: p, kind: c.kind, action: 'delete', localSha: st.sha256, exec: false });
      else out.push({ path: p, kind: c.kind, action: 'skip', reason: 'modified locally since deployment: not deleted', localSha: st.sha256, exec: false });
    }
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** Reja xeshi: foydalanuvchi ko'rgan rejaning o'zi (harakat + ikki tomon xeshi + bo'lak o'zgarishlari); diff matnlariga bog'liq emas. */
export function computePlanHash(mode: ConfigMode, entries: PlannedEntry[], settings: ConfigSettingsPlan | null): string {
  const e = entries.filter((x) => x.action !== 'unchanged').map((x) => [x.path, x.action, x.newSha ?? null, x.localSha ?? null]);
  const s = settings
    ? [settings.changed, settings.allowAdd, settings.allowRemove, settings.denyAdd, settings.denyRemove, settings.envSet, settings.envRemove, settings.refused]
    : null;
  return createHash('sha256').update(canonicalJson({ mode, e, s }), 'utf8').digest('hex');
}
