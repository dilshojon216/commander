import { ALLOW_CONFIG_CLI, ALLOW_CONFIG_HINT, CONFIG_ERROR_TEXT } from "./config-errors";
import { commandErrorText, commandHttpErrorText } from "./control-ui";

export { ALLOW_CONFIG_CLI, ALLOW_CONFIG_HINT };

/** Sozlamalarni sinxronlash (3.7) xato matnlari (sof, testlanadi). Umumiy buyruq kodlari `control-ui.ts` da qoladi. */

/** Buyruq/amal xato kodini o'zbekcha matnga o'giradi; config kodlari avval, qolganlari umumiy jadvaldan. */
export function configErrorText(code: string | null | undefined): string {
  if (code && code in CONFIG_ERROR_TEXT) return CONFIG_ERROR_TEXT[code];
  return commandErrorText(code);
}

function bodyCode(body: unknown): string {
  return typeof body === "object" && body !== null && "error" in body ? String((body as { error: unknown }).error) : "";
}

/** HTTP xatosi (so'rov yaratilmadi). Markaz `error` kodi config kodi bo'lsa — o'sha matn. */
export function configHttpErrorText(status: number, body: unknown): string {
  const code = bodyCode(body);
  if (code && code in CONFIG_ERROR_TEXT) return CONFIG_ERROR_TEXT[code];
  if (code === "machine_offline" || code === "agent_outdated" || code === "policy_disabled" || code === "agent_timeout" || code === "step_up_unavailable" || code === "step_up_expired") return commandErrorText(code);
  if (status === 404) return "Profil yoki mashina topilmadi";
  if (status === 409) return "Mashinada boshqa buyruq bajarilmoqda yoki holat o'zgargan: qayta urinib ko'ring";
  if (status === 413) return "Profil hajmi chegaradan katta";
  if (status === 502 || status === 504) return "Mashina vaqtida javob bermadi (vaqt tugadi)";
  return commandHttpErrorText(status, body);
}
