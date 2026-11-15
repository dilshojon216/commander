/**
 * Umumiy sozlamalar (6.17) proksi qoidalari: haftalik limit tezligi (6.12) va Telegram step-up istisnosi.
 * `proxy-rules.ts` shu yerdan import qiladi (sof, testlanadi).
 *
 * Hamma yozuv FAIL-CLOSED: elevation (Touch ID/parol) talab qilinadi, istisno YO'Q (sozlamani o'zgartirish va "bugun uchun ruxsat"
 * chegarani yumshatishi mumkin; step-up istisnosi xavfsizlik darajasini o'zgartiradi). Center tomonda `control` scope + audit.
 */

/** O'qish (read token). */
export const SETTINGS_GET_RULES: RegExp[] = [/^limits\/pace-settings$/, /^settings\/stepup-exemption$/];

/** Yozuvlar (`control` token). */
export const SETTINGS_WRITE_RULES: { method: "POST" | "PUT" | "PATCH" | "DELETE"; re: RegExp }[] = [
  { method: "PUT", re: /^limits\/pace-settings$/ },
  { method: "POST", re: /^limits\/pace-override$/ },
  { method: "PUT", re: /^settings\/stepup-exemption$/ },
];
