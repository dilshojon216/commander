export type PermissionMode = "default" | "acceptEdits" | "plan";

export const MODE_OPTIONS: { id: PermissionMode; label: string; hint: string }[] = [
  { id: "default", label: "Qo'lda", hint: "default: har amalda ruxsat so'raydi" },
  { id: "acceptEdits", label: "Avto", hint: "acceptEdits: fayl tahrirlari avtomatik" },
  { id: "plan", label: "Reja", hint: "plan: faqat reja tuzadi" },
];

/** `SessionDto.permissionMode` (hook'dagi oxirgi `permission_mode`): bizning 3 rejimdan biri yoki null. */
export function readPermissionMode(session: { permissionMode?: string | null }): PermissionMode | null {
  const v = session.permissionMode;
  return v === "default" || v === "acceptEdits" || v === "plan" ? v : null;
}

/** Boshqa rejimlar (bypassPermissions, dontAsk, ...): xom nom ko'rsatiladi; noma'lum/standart = null. */
export function otherPermissionMode(session: { permissionMode?: string | null }): string | null {
  const v = session.permissionMode;
  return v && readPermissionMode(session) === null ? v : null;
}

/** Sessiya turi: `interactive` -> "interaktiv". */
export function kindLabel(kind: string): string {
  return kind === "interactive" ? "interaktiv" : kind;
}
