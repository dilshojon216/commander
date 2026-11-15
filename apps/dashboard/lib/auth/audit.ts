import { appendFileSync, existsSync, renameSync, statSync } from "node:fs";
import path from "node:path";
import { authDir } from "./store";

/**
 * Kirish/chiqish/ko'tarilish hodisalari: center'da mos endpoint yo'q (audit faqat qurilma tokenlari bilan yoziladi),
 * shuning uchun lokal 0600 fayl `<authDir>/audit.log` (JSON qatorlar, 1 MB dan oshsa `.1` ga aylanadi).
 * Maxfiy qiymat (parol, sir, kod) HECH QACHON yozilmaydi.
 */
export type AuditEvent =
  | "login.ok"
  | "login.fail"
  | "login.locked"
  | "logout"
  | "elevate.ok"
  | "elevate.fail"
  | "setup.pair_app"
  | "setup.register_passkey"
  | "setup.code_fail"
  | "session.expired";

const MAX_BYTES = 1024 * 1024;

export function audit(event: AuditEvent, details: Record<string, string | number | boolean> = {}): void {
  try {
    const file = path.join(authDir(), "audit.log");
    if (existsSync(file) && statSync(file).size > MAX_BYTES) renameSync(file, `${file}.1`);
    appendFileSync(file, `${JSON.stringify({ t: new Date().toISOString(), event, ...details })}\n`, { mode: 0o600 });
  } catch {
    // audit yozilmasa ham so'rov buzilmaydi (log fayli yozib bo'lmaydigan bo'lsa); xato stderr'ga
    console.error("[auth] audit yozib bo'lmadi");
  }
}
