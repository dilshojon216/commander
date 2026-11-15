import { DEPLOY_ERROR_TEXT } from "./deploy-errors";
import { commandErrorText } from "./control-ui";

/** Deploy (6.5) xato matnlari (sof, testlanadi). Jadval `deploy-errors.ts`da. */

/** Buyruq xato kodi -> o'zbekcha (deploy matnlari ustun: masalan `dirty_worktree`). Noma'lum kod: umumiy matn. */
export function deployErrorText(code: string | null | undefined): string {
  if (!code) return "Bajarilmadi";
  return DEPLOY_ERROR_TEXT[code] ?? commandErrorText(code);
}

/** HTTP xatolari (inspect/run/rollback/restore): 409/403/404/422/504 ... */
export function deployHttpErrorText(status: number, body: unknown): string {
  const code = typeof body === "object" && body !== null && "error" in body ? String((body as { error: unknown }).error) : "";
  if (code && DEPLOY_ERROR_TEXT[code]) return DEPLOY_ERROR_TEXT[code];
  if (status === 504) return DEPLOY_ERROR_TEXT.agent_timeout ?? "Mashina javob bermadi";
  if (status === 422) return DEPLOY_ERROR_TEXT.recipe_invalid ?? "Retsept yaroqsiz";
  if (status === 409) return "So'rov mavjud holatga mos kelmadi (boshqa amal bajarilmoqda yoki holat o'zgargan)";
  if (status === 403) return "Boshqaruv uchun token ruxsati yetarli emas";
  if (status === 404) return "Loyiha yoki maqsad topilmadi";
  if (status === 400) return "So'rov ma'lumoti noto'g'ri";
  if (status === 429) return "Juda ko'p so'rov: birozdan keyin urinib ko'ring";
  if (status === 503) return "COMMANDER_CONTROL_TOKEN sozlanmagan: boshqaruv o'chiq";
  if (status === 401) return "Qayta tasdiqlash (Touch ID/parol) bekor qilindi yoki o'tmadi";
  return `Xatolik (${status || "tarmoq"})`;
}
