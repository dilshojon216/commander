/**
 * Log ko'ruvchi (6.6) va hodisadan tekshiruv (6.4) proksi qoidalari.
 * `proxy-rules.ts` shu yerdan import qiladi (sof, testlanadi).
 *
 * Log: boshlash/o'qish/to'xtatish FAQAT o'qiydigan imzolangan buyruq (`logs.tail`): elevation talab qilinmaydi
 * (autentifikatsiya yetadi). Tekshiruv (6.4): sessiya ochadi va sozlamalarni yozadi: elevation FAIL-CLOSED (istisno YO'Q).
 */

const UUID = "[0-9a-fA-F-]{36}";

/** O'qish (read token): log oqimi (cursor), tekshiruvlar ro'yxati/sozlamalari/bittasi. */
export const OPS_GET_RULES: RegExp[] = [new RegExp(`^logs/${UUID}$`), /^investigations$/, /^investigations\/settings$/, new RegExp(`^investigations/${UUID}$`)];

/** Yozuvlar (`control` token). */
export const LOGS_START_RULE = new RegExp(`^machines/${UUID}/logs$`);
export const LOGS_STOP_RULE = new RegExp(`^logs/${UUID}$`);
export const OPS_WRITE_RULES: { method: "POST" | "PUT" | "PATCH" | "DELETE"; re: RegExp }[] = [
  { method: "POST", re: LOGS_START_RULE },
  { method: "DELETE", re: LOGS_STOP_RULE },
  { method: "POST", re: /^investigations$/ },
  { method: "PUT", re: /^investigations\/settings$/ },
];

/** Faqat o'qiydigan/xavfni kamaytiradigan amallar: elevation talab qilmaydi (tekshiruv POST/PUT fail-closed qoladi). */
export const OPS_ELEVATION_EXEMPT: RegExp[] = [LOGS_START_RULE, LOGS_STOP_RULE];
