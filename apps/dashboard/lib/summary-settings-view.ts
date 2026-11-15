import type { PutSummarySettingsBody, SummarySettingsResponse } from "@commander/contracts";
import { SUMMARY_LIMITS } from "@commander/contracts";

/** Xulosa sozlamalari formasi (sof): qiymatlarni tekshirish, ro'yxat almashtirish, PUT tanasi. */

export interface SummarySettingsForm {
  enabled: boolean;
  minPrompts: string;
  minTokens: string;
  dailyCap: string;
  disabledMachineIds: string[];
  disabledProjectIds: string[];
}

export type SettingsField = "minPrompts" | "minTokens" | "dailyCap" | "disabledMachineIds" | "disabledProjectIds";
export type SettingsErrors = Partial<Record<SettingsField, string>>;

const LIMITS = { minPrompts: 1000, minTokens: 100_000_000, dailyCap: SUMMARY_LIMITS.maxDailyCap, machines: 200, projects: 500 } as const;

export function formFromSettings(s: SummarySettingsResponse): SummarySettingsForm {
  return {
    enabled: s.enabled,
    minPrompts: String(s.minPrompts),
    minTokens: String(s.minTokens),
    dailyCap: String(s.dailyCap),
    disabledMachineIds: [...s.disabledMachineIds],
    disabledProjectIds: [...s.disabledProjectIds],
  };
}

function intField(label: string, raw: string, max: number): { n: number | null; error?: string } {
  const t = raw.trim();
  if (!/^\d+$/.test(t)) return { n: null, error: `${label}: butun son (0 dan ${max} gacha)` };
  const n = Number(t);
  if (!Number.isSafeInteger(n) || n > max) return { n: null, error: `${label}: ${max} dan oshmasin` };
  return { n };
}

export function validateSettingsForm(f: SummarySettingsForm): { value: PutSummarySettingsBody | null; errors: SettingsErrors } {
  const errors: SettingsErrors = {};
  const p = intField("Eng kam prompt", f.minPrompts, LIMITS.minPrompts);
  const t = intField("Eng kam token", f.minTokens, LIMITS.minTokens);
  const c = intField("Kunlik chegara", f.dailyCap, LIMITS.dailyCap);
  if (p.error) errors.minPrompts = p.error;
  if (t.error) errors.minTokens = t.error;
  if (c.error) errors.dailyCap = c.error;
  if (f.disabledMachineIds.length > LIMITS.machines) errors.disabledMachineIds = `Mashinalar ${LIMITS.machines} tadan oshmasin`;
  if (f.disabledProjectIds.length > LIMITS.projects) errors.disabledProjectIds = `Loyihalar ${LIMITS.projects} tadan oshmasin`;
  if (p.n === null || t.n === null || c.n === null || Object.keys(errors).length > 0) return { value: null, errors };
  return {
    value: { enabled: f.enabled, minPrompts: p.n, minTokens: t.n, dailyCap: c.n, disabledMachineIds: f.disabledMachineIds, disabledProjectIds: f.disabledProjectIds },
    errors,
  };
}

/** Ro'yxatda bo'lsa olib tashlaydi, bo'lmasa qo'shadi (o'zgarmas). */
export function toggleId(list: string[], id: string): string[] {
  return list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
}

export interface NamedId {
  id: string;
  name: string;
}

/**
 * O'chirilgan ro'yxat qatorlari: ma'lum nomlar + ro'yxatda bo'lmagan (o'chirilgan/yashirin) id'lar qisqartirilgan holda,
 * nom bo'yicha tartiblangan.
 */
export function disabledRows(known: NamedId[], disabled: string[]): NamedId[] {
  const byId = new Map(known.map((k) => [k.id, k.name]));
  return disabled.map((id) => ({ id, name: byId.get(id) ?? `${id.slice(0, 8)}…` })).sort((a, b) => a.name.localeCompare(b.name));
}

export function usedTodayText(s: Pick<SummarySettingsResponse, "usedToday" | "dailyCap">): string {
  return `Bugun: ${s.usedToday} / ${s.dailyCap}`;
}
