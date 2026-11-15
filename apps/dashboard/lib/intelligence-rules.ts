/**
 * Aqlli yordamchi (6.1-6.3) proksi qoidalari: xulosalar, qidiruv, "Commander'dan savol", qarorlar jurnali.
 * `proxy-rules.ts` shu yerdan import qiladi (sof, testlanadi).
 */

const UUID = "[0-9a-fA-F-]{36}";

/** O'qish (read token). */
export const INTEL_GET_RULES: RegExp[] = [
  /^summaries\/search$/,
  /^summaries\/settings$/,
  new RegExp(`^sessions/${UUID}/summary$`),
  /^assistant\/history$/,
  new RegExp(`^projects/${UUID}/decisions$`),
];

/** Yozuvlar (`control` token). Savol (`assistant/ask`) hech narsani o'zgartirmaydi: elevation'siz (`INTEL_ELEVATION_EXEMPT`). */
export const INTEL_WRITE_RULES: { method: "POST" | "PUT" | "PATCH"; re: RegExp }[] = [
  { method: "PUT", re: /^summaries\/settings$/ },
  { method: "POST", re: /^assistant\/ask$/ },
  { method: "POST", re: new RegExp(`^projects/${UUID}/decisions$`) },
  { method: "PATCH", re: new RegExp(`^decisions/${UUID}$`) },
];

/** Faqat o'qiydigan POST: elevation talab qilmaydi (qolgan INTEL_WRITE_RULES fail-closed: elevation bilan). */
export const INTEL_ELEVATION_EXEMPT: RegExp[] = [/^assistant\/ask$/];

export const INTEL_ASK_RULE = /^assistant\/ask$/;
/** Savol javobi ~110 s gacha kutiladi (agentd `claude -p`): proksi muddati biroz uzunroq. */
export const PROXY_TIMEOUT_ASK_MS = 120_000;
/** Sozlamalar: 200 mashina + 500 loyiha uuid'i (~27 KB). Qarorlar: 1000+1000+6x200 belgi (escape bilan 16 KB yetadi). */
export const MAX_BODY_SUMMARY_SETTINGS = 64 * 1024;
export const MAX_BODY_DECISIONS = 16 * 1024;
export const SUMMARY_SETTINGS_RULE = /^summaries\/settings$/;
export const DECISION_BODY_RULES: RegExp[] = [new RegExp(`^projects/${UUID}/decisions$`), new RegExp(`^decisions/${UUID}$`)];
