/**
 * Brauzer -> dashboard -> center proksisi uchun ruxsat ro'yxati (sof, testlanadi).
 * Faqat shu yo'llar o'tadi; boshqa hamma narsa 404. `approve` tokeni faqat qaror yo'lida.
 */

import { DECISION_BODY_RULES, INTEL_ELEVATION_EXEMPT, INTEL_GET_RULES, INTEL_WRITE_RULES, MAX_BODY_DECISIONS, MAX_BODY_SUMMARY_SETTINGS, PROXY_TIMEOUT_ASK_MS, INTEL_ASK_RULE, SUMMARY_SETTINGS_RULE } from "./intelligence-rules";
import { LOGS_START_RULE, OPS_ELEVATION_EXEMPT, OPS_GET_RULES, OPS_WRITE_RULES } from "./ops-rules";
import { DEPLOY_ELEVATION_EXEMPT, DEPLOY_GET_RULES, DEPLOY_IDEMPOTENT_RULES, DEPLOY_SLOW_RULES, DEPLOY_WRITE_RULES } from "./deploy-rules";
import { SETTINGS_GET_RULES, SETTINGS_WRITE_RULES } from "./settings-rules";
import { SCAN_BUDGET_ELEVATION_EXEMPT, SCAN_BUDGET_GET_RULES, SCAN_BUDGET_WRITE_RULES, SCAN_RUN_RULE } from "./scan-budget-rules";

const UUID = "[0-9a-fA-F-]{36}";
/**
 * Hisob-kitob (6.7) / mijoz hisoboti (6.8) yozuvlari: `control` token; elevation FAIL-CLOSED qoidasi bo'yicha (istisno YO'Q):
 * mijoz CRUD, loyiha bog'lash va hisobot yaratish yangi tasdiq (Touch ID/parol) talab qiladi. Eksport/ko'rib chiqish GET (read).
 */
const BILLING_WRITE_RULES: { method: "POST" | "PUT" | "PATCH" | "DELETE"; re: RegExp }[] = [
  { method: "POST", re: /^billing\/clients$/ },
  { method: "PATCH", re: new RegExp(`^billing/clients/${UUID}$`) },
  { method: "DELETE", re: new RegExp(`^billing/clients/${UUID}$`) },
  { method: "PUT", re: new RegExp(`^billing/clients/${UUID}/projects$`) },
  { method: "POST", re: /^client-reports$/ },
];
const BILLING_PROJECTS_RULE = new RegExp(`^billing/clients/${UUID}/projects$`);
/** Timesheet/eksport/mijoz hisoboti og'ir SQL + PDF/XLSX: proksi muddati uzaytiriladi. */
const BILLING_SLOW_RULE = /^(billing\/timesheet(\/export)?|client-reports(\/preview)?)$/;
const GET_RULES: RegExp[] = [
  // Hisob-kitob (6.7) va mijoz hisoboti (6.8): o'qish, eksport (fayl JSON ichida), ko'rib chiqish
  /^billing\/(clients|projects|timesheet|timesheet\/export)$/,
  /^client-reports$/,
  /^client-reports\/preview$/,
  // Aqlli yordamchi (6.1-6.3): o'qish
  ...INTEL_GET_RULES,
  // Log ko'ruvchi (6.6) va tekshiruvlar (6.4): o'qish
  ...OPS_GET_RULES,
  // Xavfsizlik tekshiruvi (6.10) va byudjetlar (6.11): o'qish
  ...SCAN_BUDGET_GET_RULES,
  // Umumiy sozlamalar (6.17): haftalik limit tezligi, step-up istisnosi: o'qish
  ...SETTINGS_GET_RULES,
  // Deploy (6.5) va git checkpoint (6.9): o'qish
  ...DEPLOY_GET_RULES,
  /^machines$/,
  /^sessions$/,
  new RegExp(`^sessions/${UUID}$`),
  new RegExp(`^sessions/${UUID}/events$`),
  /^projects$/,
  /^usage$/,
  /^usage\/summary$/,
  /^limits$/,
  // Vazifalar navbati (3.1): o'qish
  /^queue$/,
  new RegExp(`^queue/${UUID}$`),
  // Prompt shablonlari (3.4): o'qish
  /^templates$/,
  new RegExp(`^templates/${UUID}$`),
  // Orkestratsiya (3.9): o'qish
  /^orchestrations$/,
  new RegExp(`^orchestrations/${UUID}$`),
  /^approvals$/,
  /^commands$/,
  /^approval-rules$/,
  new RegExp(`^approvals/${UUID}$`),
  new RegExp(`^commands/${UUID}$`),
  new RegExp(`^projects/${UUID}$`),
  new RegExp(`^projects/${UUID}/(tasks|commits|daily|md-files|git|parts)$`),
  /^tasks$/,
  // Server salomatligi (3.8): faqat o'qish (chegaralarni o'zgartirish API orqali, `admin` token bilan)
  new RegExp(`^machines/${UUID}/health$`),
  /^health\/(summary|incidents|thresholds)$/,
  // Markaz o'z holati (5.5): faqat o'qish
  /^center\/health$/,
  /^messaging\/(settings|groups|group|messages)$/,
  new RegExp(`^sessions/${UUID}/commands$`),
  // Watchdog ogohlantirishlari va hisobotlar (3.2/3.3): o'qish
  /^alerts$/,
  /^watchdog\/settings$/,
  /^reports$/,
  /^reports\/settings$/,
  new RegExp(`^reports/${UUID}$`),
  // Sozlamalarni sinxronlash (3.7): o'qish
  /^config\/profiles$/,
  new RegExp(`^config/profiles/${UUID}$`),
  new RegExp(`^config/profiles/${UUID}/file$`),
  /^config\/status$/,
  /^config\/settings$/,
];
/** Navbat yozuvlari (3.1): `control` token (center step-up'ni o'zi talab qiladi: Mac dashboard istisnosi). */
const QUEUE_ITEM = new RegExp(`^queue/${UUID}$`);
/** Shablonlar (3.4): yozuvlar va sessiyaga yuborish `control`, render (hech narsa yozmaydi) `read` token bilan. */
const TEMPLATE_ITEM = new RegExp(`^templates/${UUID}$`);
const TEMPLATE_RENDER = new RegExp(`^templates/${UUID}/render$`);
const TEMPLATE_SEND = new RegExp(`^templates/${UUID}/send-prompt$`);
const QUEUE_ACTION = new RegExp(`^queue/${UUID}/(run-now|cancel)$`);
/** Orkestratsiya (3.9): boshlash va to'xtatish `control` token bilan (center step-up'ni o'zi talab qiladi). */
const ORCH_CANCEL = new RegExp(`^orchestrations/${UUID}/cancel$`);
const DECISION_RULE = new RegExp(`^approvals/(${UUID})/decision$`);
/** Masofaviy boshqaruv: faqat buyruq yaratish va bekor qilish (`control` token). */
const COMMAND_CREATE_RULE = /^commands$/;
const COMMAND_CANCEL_RULE = new RegExp(`^commands/${UUID}/cancel$`);
/** H-04/H-06: faqat `review.required` buyruqlar dashboard'da tasdiqlanadi (`approve` token; center boshqa buyruqlarni rad etadi). */
const COMMAND_CONFIRM_RULE = new RegExp(`^commands/${UUID}/confirm$`);
/** Loyiha ish maydoni yozuvlari (2.15): hammasi `control` token bilan. */
const WORK_POST_RULES: RegExp[] = [
  new RegExp(`^projects/${UUID}/daily/\\d{4}-\\d{2}-\\d{2}/summary$`),
  new RegExp(`^projects/${UUID}/md-extract$`),
  new RegExp(`^projects/${UUID}/tasks/append$`),
  new RegExp(`^projects/${UUID}/refresh$`),
  // Git/PR (3.5): diff (loyiha/sessiya), PR ochish, CI yangilash: hammasi `control` token (center audit qiladi, PR step-up talab qiladi)
  new RegExp(`^projects/${UUID}/(diff|pr|ci/refresh)$`),
  new RegExp(`^sessions/${UUID}/diff$`),
];
/** Sessiyalararo xabar (2.10): yozuvlar `control` token bilan; guruh kaliti ("/" bor) doim query/body'da. */
const MSG_WRITE_RULES: { method: "POST" | "PUT" | "PATCH" | "DELETE"; re: RegExp }[] = [
  // Aqlli yordamchi (6.1-6.3): yozuvlar `control` token bilan (savol elevation'siz; qolganlari elevation bilan)
  ...INTEL_WRITE_RULES,
  // Log ko'ruvchi (6.6) va tekshiruvlar (6.4) yozuvlari
  ...OPS_WRITE_RULES,
  // Xavfsizlik tekshiruvi (6.10) va byudjetlar (6.11) yozuvlari
  ...SCAN_BUDGET_WRITE_RULES,
  // Umumiy sozlamalar (6.17) yozuvlari: `control` token + elevation (fail-closed, istisnosiz)
  ...SETTINGS_WRITE_RULES,
  // Deploy (6.5) va git checkpoint (6.9) yozuvlari
  ...DEPLOY_WRITE_RULES,
  // Loyihani arxivlash (6.16): ro'yxatdan yashirish (ma'lumot o'chmaydi); `control` token + elevation (fail-closed, istisnosiz)
  { method: "POST", re: new RegExp(`^projects/${UUID}/(archive|unarchive)$`) },
  { method: "PUT", re: /^messaging\/settings$/ },
  { method: "PATCH", re: /^messaging\/groups$/ },
  { method: "PUT", re: /^messaging\/groups\/(context|rules)$/ },
  { method: "PUT", re: new RegExp(`^messaging/sessions/${UUID}/role$`) },
  { method: "PUT", re: /^messaging\/links$/ },
  { method: "DELETE", re: /^messaging\/links$/ },
  { method: "POST", re: /^messaging\/messages$/ },
  // Watchdog / hisobotlar yozuvlari (3.2/3.3): `control` token bilan
  { method: "POST", re: new RegExp(`^alerts/${UUID}/dismiss$`) },
  { method: "PUT", re: /^watchdog\/settings$/ },
  { method: "PUT", re: /^reports\/settings$/ },
  { method: "POST", re: /^reports\/generate$/ },
  // Sozlamalarni sinxronlash (3.7): yozuvlar `control` token bilan (apply/rollback uchun center step-up'ni o'zi talab qiladi)
  { method: "PUT", re: /^config\/settings$/ },
  { method: "POST", re: /^config\/profiles\/capture$/ },
  { method: "POST", re: new RegExp(`^config/machines/${UUID}/(diff|apply|rollback)$`) },
];
/** Avto-ruxsat qoidalari (2.13): yaratish va bekor qilish `control` token bilan (center step-up'ni o'zi talab qiladi). */
const RULE_CREATE_RULE = /^approval-rules$/;
const RULE_REVOKE_RULE = /^approval-rules\/[0-9]{1,18}$/;
// Qism vazifalari (6.15) kaliti `<slug>:<kalit>` (`:` URL'da `%3A` bo'lishi mumkin) — contracts TASK_KEY_ANY_RE bilan mos
const BOARD_PATCH_RULE = new RegExp(`^projects/${UUID}/tasks/(?:[a-z0-9][a-z0-9._~-]{0,127}(?::|%3A))?[a-z0-9][a-z0-9._-]{0,31}/board$`);
const APPEND_RULE = new RegExp(`^projects/${UUID}/tasks/append$`);
/** PR ochish tanasi (sarlavha + 16 000 belgigacha tana). */
const PR_RULE = new RegExp(`^projects/${UUID}/pr$`);

/** Tana chegarasi (bayt emas, belgi): prompt 16 000 belgigacha bo'lishi mumkin. */
export const MAX_BODY_DEFAULT = 4096;
export const MAX_BODY_COMMAND = 64 * 1024;
const MSG_CONTEXT_RULE = /^messaging\/groups\/context$/;
const MSG_MEDIUM_RULE = /^messaging\/(messages|groups\/rules)$/;

/** POST tana chegarasi: buyruq yaratish (prompt matni) kattaroq, qolganlari kichik. */
const MAX_BODY_ANSWERS = 16 * 1024;

export function maxBodyFor(segments: string[]): number {
  const p = segments.join("/");
  if (BILLING_PROJECTS_RULE.test(p)) return 64 * 1024; // 100 tagacha loyiha kaliti (har biri <= 300 belgi)
  if (p === "commands" || p === "queue" || p === "templates" || TEMPLATE_ITEM.test(p) || QUEUE_ITEM.test(p) || APPEND_RULE.test(p) || MSG_CONTEXT_RULE.test(p)) return MAX_BODY_COMMAND;
  if (PR_RULE.test(p)) return MAX_BODY_COMMAND;
  if (SUMMARY_SETTINGS_RULE.test(p)) return MAX_BODY_SUMMARY_SETTINGS;
  // Ruxsat qarori (AskUserQuestion javoblari bilan, 6.13): 4 savol x erkin matn (<= 1000 belgi) sig'sin.
  if (DECISION_RULE.test(p)) return MAX_BODY_ANSWERS;
  if (DECISION_BODY_RULES.some((r) => r.test(p))) return MAX_BODY_DECISIONS;
  if (MSG_MEDIUM_RULE.test(p)) return 16 * 1024;
  if (p === "watchdog/settings") return 64 * 1024; // 200 tagacha qayta belgilash
  return MAX_BODY_DEFAULT;
}

/** `Idempotency-Key` yo'q bo'lsa serverda yaratiladigan yo'llar (buyruq yaratuvchi POST'lar). */
export function needsIdempotencyKey(segments: string[]): boolean {
  const p = segments.join("/");
  return p === "commands" || TEMPLATE_SEND.test(p) || APPEND_RULE.test(p) || WORK_POST_RULES.some((r) => r.test(p)) || CONFIG_SLOW_RULE.test(p) || LOGS_START_RULE.test(p) || SCAN_RUN_RULE.test(p) || DEPLOY_IDEMPOTENT_RULES.some((r) => r.test(p));
}

/** Sozlamalar sinxronlash buyruqlari (3.7): center agentni kutadi (capture/diff ~45 s), shuning uchun proksi muddati uzaytiriladi. */
const CONFIG_SLOW_RULE = new RegExp(`^config/(profiles/capture|machines/${UUID}/(diff|apply|rollback))$`);
export const PROXY_TIMEOUT_DEFAULT_MS = 5000;
export const PROXY_TIMEOUT_CONFIG_MS = 60_000;

/** Center'ga so'rov muddati (ms): agent natijasini sinxron kutadigan config yo'llari uchun uzoqroq. */
export function proxyTimeoutFor(segments: string[]): number {
  const p = segments.join("/");
  if (BILLING_SLOW_RULE.test(p)) return PROXY_TIMEOUT_CONFIG_MS;
  if (INTEL_ASK_RULE.test(p)) return PROXY_TIMEOUT_ASK_MS;
  if (DEPLOY_SLOW_RULES.some((r) => r.test(p))) return PROXY_TIMEOUT_CONFIG_MS;
  return CONFIG_SLOW_RULE.test(p) ? PROXY_TIMEOUT_CONFIG_MS : PROXY_TIMEOUT_DEFAULT_MS;
}

export type ProxyDecision =
  | { ok: true; scope: "read" | "approve" | "control"; method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE" }
  | { ok: false; status: 404 | 405 };

export function classifyProxyRequest(method: string, segments: string[]): ProxyDecision {
  const path = segments.join("/");
  if (segments.some((s) => s === "" || s === "." || s === ".." || s.includes("\\"))) return { ok: false, status: 404 };
  if (DECISION_RULE.test(path)) {
    return method === "POST" ? { ok: true, scope: "approve", method: "POST" } : { ok: false, status: 405 };
  }
  if (COMMAND_CREATE_RULE.test(path)) {
    if (method === "POST") return { ok: true, scope: "control", method: "POST" };
    if (method !== "GET") return { ok: false, status: 405 };
    // GET: ro'yxat (tasdiq kutayotganlar) o'qish qoidalariga o'tadi
  }
  if (path === "orchestrations") {
    if (method === "POST") return { ok: true, scope: "control", method: "POST" };
    if (method !== "GET") return { ok: false, status: 405 };
  }
  if (ORCH_CANCEL.test(path)) {
    return method === "POST" ? { ok: true, scope: "control", method: "POST" } : { ok: false, status: 405 };
  }
  if (path === "queue") {
    if (method === "POST") return { ok: true, scope: "control", method: "POST" };
    if (method !== "GET") return { ok: false, status: 405 };
  }
  if (path === "templates") {
    if (method === "POST") return { ok: true, scope: "control", method: "POST" };
    if (method !== "GET") return { ok: false, status: 405 };
  }
  if (TEMPLATE_ITEM.test(path)) {
    if (method === "PATCH" || method === "DELETE") return { ok: true, scope: "control", method };
    if (method !== "GET") return { ok: false, status: 405 };
  }
  if (TEMPLATE_RENDER.test(path)) {
    return method === "POST" ? { ok: true, scope: "read", method: "POST" } : { ok: false, status: 405 };
  }
  if (TEMPLATE_SEND.test(path)) {
    return method === "POST" ? { ok: true, scope: "control", method: "POST" } : { ok: false, status: 405 };
  }
  if (QUEUE_ACTION.test(path)) {
    return method === "POST" ? { ok: true, scope: "control", method: "POST" } : { ok: false, status: 405 };
  }
  if (QUEUE_ITEM.test(path)) {
    if (method === "PATCH" || method === "DELETE") return { ok: true, scope: "control", method };
    if (method !== "GET") return { ok: false, status: 405 };
  }
  if (COMMAND_CONFIRM_RULE.test(path)) {
    // H-01 (5.6): lokal autentifikatsiya + elevation (`elevationFor`) bor, shuning uchun yo'l qayta ochildi (`approve` token).
    return method === "POST" ? { ok: true, scope: "approve", method: "POST" } : { ok: false, status: 405 };
  }
  if (COMMAND_CANCEL_RULE.test(path)) {
    return method === "POST" ? { ok: true, scope: "control", method: "POST" } : { ok: false, status: 405 };
  }
  if (RULE_REVOKE_RULE.test(path)) {
    return method === "DELETE" ? { ok: true, scope: "control", method: "DELETE" } : { ok: false, status: 405 };
  }
  if (RULE_CREATE_RULE.test(path) && method === "POST") return { ok: true, scope: "control", method: "POST" };
  if (WORK_POST_RULES.some((r) => r.test(path))) {
    return method === "POST" ? { ok: true, scope: "control", method: "POST" } : { ok: false, status: 405 };
  }
  const bw = BILLING_WRITE_RULES.filter((r) => r.re.test(path));
  if (bw.length > 0) {
    const hit = bw.find((r) => r.method === method);
    if (hit) return { ok: true, scope: "control", method: hit.method };
    if (method !== "GET") return { ok: false, status: 405 };
    // GET: o'qish qoidalariga o'tadi
  }
  const msg = MSG_WRITE_RULES.filter((r) => r.re.test(path));
  const knownWrite = msg.length > 0;
  if (knownWrite) {
    const hit = msg.find((r) => r.method === method);
    if (hit) return { ok: true, scope: "control", method: hit.method };
    if (method !== "GET") return { ok: false, status: 405 };
    // GET: o'qish qoidalariga o'tadi (bir yo'lda ham o'qish, ham yozish bo'lishi mumkin)
  }
  if (BOARD_PATCH_RULE.test(path)) {
    return method === "PATCH" ? { ok: true, scope: "control", method: "PATCH" } : { ok: false, status: 405 };
  }
  if (GET_RULES.some((r) => r.test(path))) {
    return method === "GET" ? { ok: true, scope: "read", method: "GET" } : { ok: false, status: 405 };
  }
  return { ok: false, status: knownWrite ? 405 : 404 };
}

/** POST uchun CSRF himoyasi: Origin (bo'lsa) Host bilan bir xil bo'lishi shart. */
export function isSameOrigin(origin: string | null, host: string | null): boolean {
  if (!origin) return false;
  try {
    return new URL(origin).host.toLowerCase() === (host ?? "").toLowerCase();
  } catch {
    return false;
  }
}

/**
 * H-01: xavfli amallar uchun "yangi tasdiq" (elevation) talabi.
 *  - `none`: faqat o'qish yoki xavfni kamaytiradigan amal (bekor qilish, rad etish, to'xtatish ...).
 *  - `required`: har doim elevation kerak.
 *  - `decision`: ruxsat qarori: `deny` elevation'siz, `allow` elevation bilan (tanani ko'rib hal qilinadi).
 *  - `command`: `POST /commands`: `session.stop` elevation'siz, qolgan hamma buyruq (start, prompt, set_mode, remote_control ...) bilan.
 * Qoida FAIL-CLOSED: o'zgartiruvchi har qanday ruxsat etilgan yo'l, quyidagi ochiq istisno ro'yxatida bo'lmasa, elevation talab qiladi.
 */
export type Elevation = "none" | "required" | "decision" | "command";

const QUEUE_CANCEL = new RegExp(`^queue/${UUID}/cancel$`);
const ELEVATION_EXEMPT: RegExp[] = [
  COMMAND_CANCEL_RULE,
  QUEUE_CANCEL,
  ORCH_CANCEL,
  RULE_REVOKE_RULE,
  new RegExp(`^alerts/${UUID}/dismiss$`),
  TEMPLATE_RENDER,
  // Faqat o'qiydigan agent buyruqlari (diff, CI holati, loyiha snapshot'ini yangilash) va kanban holati
  new RegExp(`^projects/${UUID}/(diff|ci/refresh|refresh)$`),
  new RegExp(`^sessions/${UUID}/diff$`),
  BOARD_PATCH_RULE,
  /^templates$/,
  // "Commander'dan savol": hech narsani o'zgartirmaydi
  ...INTEL_ELEVATION_EXEMPT,
  // Log ko'ruvchi (6.6): faqat o'qiydigan buyruq (boshlash/to'xtatish)
  ...OPS_ELEVATION_EXEMPT,
  // Xavfsizlik tekshiruvi (6.10): faqat o'qiydigan buyruq
  ...SCAN_BUDGET_ELEVATION_EXEMPT,
  // Deploy inspect va checkpoint yaratish/ro'yxat: ishchi daraxtni o'zgartirmaydi (run/rollback/restore fail-closed)
  ...DEPLOY_ELEVATION_EXEMPT,
];

export function elevationFor(method: string, segments: string[]): Elevation {
  if (method === "GET") return "none";
  const path = segments.join("/");
  if (DECISION_RULE.test(path)) return "decision";
  if (path === "commands" && method === "POST") return "command";
  // Navbat elementi: DELETE (olib tashlash) elevation'siz, PATCH (prompt o'zgartirish) elevation bilan
  if (QUEUE_ITEM.test(path)) return method === "DELETE" ? "none" : "required";
  // Saqlangan shablon matnini tahrirlash/o'chirish hech narsani ishga tushirmaydi (yuborish `send-prompt` da elevation talab qiladi)
  if (TEMPLATE_ITEM.test(path)) return "none";
  if (ELEVATION_EXEMPT.some((r) => r.test(path))) return "none";
  return "required";
}

/** `elevationFor` natijasi va (kerak bo'lsa) so'rov tanasi bo'yicha: elevation talab qilinadimi. */
export function elevationRequired(elevation: Elevation, body: unknown): boolean {
  if (elevation === "none") return false;
  if (elevation === "required") return true;
  const o = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  if (elevation === "decision") return o.behavior !== "deny";
  return o.type !== "session.stop";
}
