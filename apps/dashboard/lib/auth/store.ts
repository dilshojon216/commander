import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

/**
 * H-01: autentifikatsiya holati diskda (`DASHBOARD_AUTH_DIR`, sukut `<cwd>/.auth`, papka 0700, fayllar 0600).
 * Nega fayl: Next `proxy.ts` va route handler'lar alohida bundle'lar (umumiy global holatga tayanib bo'lmaydi), jarayon
 * qayta ishga tushganda sessiyalar saqlansin, CLI (`scripts/auth-cli.mjs`) esa sozlash kodi/parolni shu yerga yozadi.
 * Sessiya identifikatori va sozlash kodi diskda FAQAT xesh sifatida turadi: fayl o'qilsa ham sessiyani o'g'irlab bo'lmaydi.
 */

export interface PasskeyRecord {
  id: string;
  /** COSE public key (base64url). */
  publicKey: string;
  counter: number;
  transports?: string[];
  name: string;
  createdAt: number;
}

export interface Credentials {
  version: 1;
  /** WebAuthn user handle (bir marta yaratiladi; shu foydalanuvchining barcha passkey'lari bir xil). */
  userId?: string;
  password?: { hash: string; setAt: number };
  passkeys: PasskeyRecord[];
  /** Mac ilova siri: faqat xeshi (siri Keychain'da). */
  app?: { secretHash: string; pairedAt: number; name: string };
}

export interface SetupState {
  codeHash: string;
  expiresAt: number;
  attempts: number;
  createdAt: number;
}

export type AuthMethod = "passkey" | "password" | "app";

export interface SessionRecord {
  createdAt: number;
  lastSeen: number;
  elevatedUntil: number;
  csrf: string;
  method: AuthMethod;
}

export type ChallengePurpose = "register" | "login" | "elevate" | "app-elevate";

export interface ChallengeRecord {
  purpose: ChallengePurpose;
  /** Passkey uchun: WebAuthn challenge (base64url). `app-elevate` uchun: bo'sh. */
  challenge: string;
  /** `elevate` / `app-elevate` shu sessiyaga bog'liq (xesh). */
  sessionHash?: string;
  expiresAt: number;
}

export function authDir(): string {
  const dir = process.env.DASHBOARD_AUTH_DIR?.trim() || path.join(process.cwd(), ".auth");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    if ((statSync(dir).mode & 0o077) !== 0) chmodSync(dir, 0o700);
  } catch {
    // ruxsatni tuzatib bo'lmasa ham ishlashda davom etadi (fayllar baribir 0600)
  }
  return dir;
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path.join(authDir(), file), "utf8")) as T;
  } catch {
    return fallback;
  }
}

/** Atomik yozish: vaqtinchalik fayl (0600) -> rename. */
function writeJson(file: string, data: unknown): void {
  const dir = authDir();
  const tmp = path.join(dir, `.${file}.${randomBytes(4).toString("hex")}.tmp`);
  writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
  renameSync(tmp, path.join(dir, file));
}

export function loadCredentials(): Credentials {
  const c = readJson<Partial<Credentials>>("credentials.json", {});
  return { version: 1, userId: c.userId, password: c.password, passkeys: Array.isArray(c.passkeys) ? c.passkeys : [], app: c.app };
}
export function saveCredentials(c: Credentials): void {
  writeJson("credentials.json", c);
}

export function loadSetup(): SetupState | null {
  const s = readJson<SetupState | null>("setup.json", null);
  return s && typeof s.codeHash === "string" && typeof s.expiresAt === "number" ? s : null;
}
export function saveSetup(s: SetupState | null): void {
  writeJson("setup.json", s);
}

export function loadSessions(): Record<string, SessionRecord> {
  return readJson<Record<string, SessionRecord>>("sessions.json", {});
}
export function saveSessions(s: Record<string, SessionRecord>): void {
  writeJson("sessions.json", s);
}

export function loadChallenges(): Record<string, ChallengeRecord> {
  return readJson<Record<string, ChallengeRecord>>("challenges.json", {});
}
export function saveChallenges(c: Record<string, ChallengeRecord>): void {
  writeJson("challenges.json", c);
}
