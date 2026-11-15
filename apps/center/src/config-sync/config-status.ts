import type { ConfigMachineState, ConfigStateReport } from '@commander/contracts';

/** Eng yangi profil versiyasi (taqqoslash maqsadi). */
export interface LatestProfileRef {
  version: number;
  files: Array<{ path: string; sha256: string }>;
  settingsSha256: string | null;
}

export interface MachineConfigInput {
  supported: boolean;
  report: ConfigStateReport | null;
}

export type ConfigStatusCore = Pick<ConfigMachineState, 'status' | 'applied' | 'latestVersion' | 'drift' | 'backups'>;

const NO_DRIFT: ConfigMachineState['drift'] = { outdated: false, modified: [], missing: [], settings: false };

/**
 * Mashina holati (sof): agent hisoboti va qo'llangan profil nomining ENG YANGI versiyasi bo'yicha.
 *  - `unsupported`: agentd 3.7 ni bilmaydi; `unknown`: hisobot hali yo'q; `not_applied`: hech qachon qo'llanmagan;
 *  - `drift`: eskirgan versiya yoki fayl o'zgargan/yo'q yoki bo'lak joyida emas; aks holda `in_sync`.
 */
export function computeConfigStatus(i: MachineConfigInput, latest: LatestProfileRef | null): ConfigStatusCore {
  if (!i.supported) return { status: 'unsupported', applied: null, latestVersion: null, drift: NO_DRIFT, backups: [] };
  if (!i.report) return { status: 'unknown', applied: null, latestVersion: null, drift: NO_DRIFT, backups: [] };
  const r = i.report;
  const applied = r.applied ? { profileName: r.applied.profileName, profileVersion: r.applied.profileVersion, mode: r.applied.mode, appliedAt: new Date(r.applied.appliedAt).toISOString() } : null;
  if (!applied) return { status: 'not_applied', applied: null, latestVersion: latest?.version ?? null, drift: NO_DRIFT, backups: r.backups };
  if (!latest) return { status: 'unknown', applied, latestVersion: null, drift: NO_DRIFT, backups: r.backups };

  const reported = new Map(r.files.map((f) => [f.path, f.sha256]));
  const modified: string[] = [];
  const missing: string[] = [];
  for (const f of latest.files) {
    const got = reported.get(f.path);
    if (got === undefined || got === null) missing.push(f.path);
    else if (got !== f.sha256) modified.push(f.path);
  }
  const outdated = applied.profileVersion !== latest.version;
  const settings = latest.settingsSha256 !== null ? r.settings === null || r.settings.sha256 !== latest.settingsSha256 || !r.settings.intact : r.settings !== null && !r.settings.intact;
  const drift = { outdated, modified: modified.sort(), missing: missing.sort(), settings };
  const inSync = !outdated && modified.length === 0 && missing.length === 0 && !settings;
  return { status: inSync ? 'in_sync' : 'drift', applied, latestVersion: latest.version, drift, backups: r.backups };
}
