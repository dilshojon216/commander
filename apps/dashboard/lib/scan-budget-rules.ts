/**
 * Xavfsizlik tekshiruvi (6.10) va kunlik byudjet (6.11) proksi qoidalari.
 * `proxy-rules.ts` shu yerdan import qiladi (sof, testlanadi).
 *
 * `POST projects/:id/scan` = FAQAT o'qiydigan imzolangan buyruq: `control` token, elevation kerak emas.
 * Sozlamalarni yozish (`scan-settings`, `budgets`, `budgets/override`) FAIL-CLOSED: elevation talab qilinadi (istisno YO'Q).
 */

const UUID = "[0-9a-fA-F-]{36}";

/** O'qish (read token). */
export const SCAN_BUDGET_GET_RULES: RegExp[] = [/^scans$/, new RegExp(`^scans/${UUID}$`), new RegExp(`^projects/${UUID}/scans$`), /^scan-settings$/, /^budgets$/];

export const SCAN_RUN_RULE = new RegExp(`^projects/${UUID}/scan$`);

/** Yozuvlar (`control` token). */
export const SCAN_BUDGET_WRITE_RULES: { method: "POST" | "PUT" | "PATCH" | "DELETE"; re: RegExp }[] = [
  { method: "POST", re: SCAN_RUN_RULE },
  { method: "PUT", re: /^scan-settings$/ },
  { method: "PUT", re: /^budgets$/ },
  { method: "POST", re: /^budgets\/override$/ },
];

/** Elevation talab qilmaydigan (faqat o'qiydigan) amallar. */
export const SCAN_BUDGET_ELEVATION_EXEMPT: RegExp[] = [SCAN_RUN_RULE];
