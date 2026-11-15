import type { MachineDto } from "@commander/contracts";

export interface HideRules {
  /** `legacy_unverified` mashinalarni yashirish (faqat eski v0 hook ko'rgan, agentd yo'q). */
  legacy: boolean;
  /** hostname yoki slug aniq mosligi (kichik harf). */
  names: string[];
}

/** Sinov mashinalari (`zz-*`, `tg-*` test fixture'lari): hech qachon ko'rsatilmaydi. */
const TEST_MACHINE = /^(zz|tg)-/i;

export function isHiddenMachine(m: Pick<MachineDto, "hostname" | "slug" | "identityStatus">, rules: HideRules): boolean {
  if (rules.legacy && m.identityStatus === "legacy_unverified") return true;
  if (TEST_MACHINE.test(m.slug) || (m.hostname !== null && TEST_MACHINE.test(m.hostname))) return true;
  const names = new Set(rules.names);
  return names.has(m.slug.toLowerCase()) || (m.hostname !== null && names.has(m.hostname.toLowerCase()));
}

/** `name-<64 hex>-<6 hex>` ko'rinishidagi slug'dan o'qiladigan nom. */
export function shortSlug(slug: string): string {
  return slug.replace(/-[0-9a-f]{16,}(-[0-9a-f]{4,})?$/, "");
}

/**
 * Qisqa ko'rsatiladigan mashina nomi: `displayName` -> `hostname` -> qisqartirilgan slug.
 * (Slug'da uzun hash bor; hostname'dagi `.local` qo'shimchasi tashlanadi.)
 */
export function machineLabel(m: Pick<MachineDto, "displayName" | "hostname" | "slug">): string {
  const name = m.displayName?.trim() || m.hostname?.trim() || shortSlug(m.slug);
  return name.replace(/\.local$/i, "");
}

/** Sessiya/approval DTO'dagi nom (u `displayName ?? hostname ?? slug` bo'lishi mumkin) ham qisqartiriladi. */
export function shortMachineName(name: string): string {
  return shortSlug(name).replace(/\.local$/i, "");
}

export type OsKind = "darwin" | "linux" | "win32" | "other";

export function osKind(os: string | null): OsKind {
  const v = (os ?? "").toLowerCase();
  if (v === "darwin" || v === "macos") return "darwin";
  if (v === "linux") return "linux";
  if (v === "win32" || v === "windows") return "win32";
  return "other";
}

/** id -> qisqa nom xaritasi (approval'lar `machineId` bilan keladi). */
export function machineNameMap(machines: Pick<MachineDto, "id" | "displayName" | "hostname" | "slug">[]): Map<string, string> {
  return new Map(machines.map((m) => [m.id, machineLabel(m)]));
}

/** `machineId` bo'yicha faqat ko'rinadigan mashinalar yozuvlari (`enabled=false` = filtrlamaydi). */
export function filterByVisibleMachines<T extends { machineId: string }>(items: readonly T[], visible: ReadonlyArray<Pick<MachineDto, "id">>, enabled: boolean): T[] {
  if (!enabled) return [...items];
  const ids = new Set(visible.map((m) => m.id));
  return items.filter((i) => ids.has(i.machineId));
}
