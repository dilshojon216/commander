#!/usr/bin/env node
// H-01: dashboard lokal autentifikatsiyasi uchun egasining CLI'si (faqat Node ichki modullari, bog'liqlik yo'q).
//   setup              bir martalik sozlash kodi (10 daqiqa): passkey qo'shish yoki Mac ilovani juftlash uchun
//   password           zaxira parolni o'rnatish/almashtirish (scrypt xesh, 0600 fayl)
//   status             nima sozlangan (sirlarsiz)
//   revoke-sessions    barcha sessiyalarni tugatish
//   remove <password|passkeys|app>   usulni olib tashlash
//   audit [N]          oxirgi N ta audit qatori
// `setup`, `password`, `remove` FAQAT interaktiv terminaldan (TTY) ishlaydi: Claude/skript (TTY'siz) jimgina o'z kirish
// usulini qo'sha olmasin. Eslatma: bu to'liq himoya emas (shu foydalanuvchi ostidagi hujumchi TTY ochishi mumkin),
// shuning uchun qo'shimcha: har bir kirish usuli faqat egasining ishtirokida ishlaydi (Touch ID/parol).
import { createHash, randomBytes, randomInt, scrypt } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SETUP_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const SETUP_TTL_MS = 10 * 60_000;
const MIN_PASSWORD = 12;

export function authDir(env = process.env, here = path.dirname(fileURLToPath(import.meta.url))) {
  const dir = env.DASHBOARD_AUTH_DIR?.trim() || path.join(here, "..", ".auth");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  if ((statSync(dir).mode & 0o077) !== 0) chmodSync(dir, 0o700);
  return dir;
}

function readJson(dir, file, fallback) {
  try {
    return JSON.parse(readFileSync(path.join(dir, file), "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(dir, file, data) {
  const tmp = path.join(dir, `.${file}.${randomBytes(4).toString("hex")}.tmp`);
  writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
  renameSync(tmp, path.join(dir, file));
}

export function generateSetupCode() {
  let s = "";
  for (let i = 0; i < 8; i++) s += SETUP_ALPHABET[randomInt(SETUP_ALPHABET.length)];
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

export const setupCodeHash = (code) => createHash("sha256").update(code.toUpperCase().replace(/[^A-Z0-9]/g, "")).digest("hex");

export function hashPassword(password) {
  const N = 1 << 16;
  const salt = randomBytes(16);
  return new Promise((resolve, reject) => {
    scrypt(password.normalize("NFKC"), salt, 32, { N, r: 8, p: 1, maxmem: 192 * 1024 * 1024 }, (err, key) => (err ? reject(err) : resolve(`scrypt$${N}$8$1$${salt.toString("base64")}$${key.toString("base64")}`)));
  });
}

export function issueSetupCode(dir, now = Date.now()) {
  const code = generateSetupCode();
  writeJson(dir, "setup.json", { codeHash: setupCodeHash(code), expiresAt: now + SETUP_TTL_MS, attempts: 0, createdAt: now });
  return { code, expiresAt: now + SETUP_TTL_MS };
}

export async function setPassword(dir, password, now = Date.now()) {
  if (password.length < MIN_PASSWORD) throw new Error(`Parol kamida ${MIN_PASSWORD} belgi bo'lsin`);
  const creds = readJson(dir, "credentials.json", {});
  creds.version = 1;
  creds.passkeys = Array.isArray(creds.passkeys) ? creds.passkeys : [];
  creds.password = { hash: await hashPassword(password), setAt: now };
  writeJson(dir, "credentials.json", creds);
  writeJson(dir, "sessions.json", {}); // parol o'zgarganda eski sessiyalar tugaydi
}

export function removeMethod(dir, what) {
  const creds = readJson(dir, "credentials.json", {});
  if (what === "password") delete creds.password;
  else if (what === "passkeys") creds.passkeys = [];
  else if (what === "app") delete creds.app;
  else throw new Error("remove: password | passkeys | app");
  writeJson(dir, "credentials.json", creds);
  writeJson(dir, "sessions.json", {});
}

export function status(dir, now = Date.now()) {
  const creds = readJson(dir, "credentials.json", {});
  const setup = readJson(dir, "setup.json", null);
  const sessions = readJson(dir, "sessions.json", {});
  const live = Object.values(sessions).filter((s) => now - s.lastSeen < 2 * 3600_000 && now - s.createdAt < 12 * 3600_000).length;
  return {
    password: !!creds.password,
    passkeys: Array.isArray(creds.passkeys) ? creds.passkeys.map((p) => ({ name: p.name, createdAt: new Date(p.createdAt).toISOString() })) : [],
    app: creds.app ? { name: creds.app.name, pairedAt: new Date(creds.app.pairedAt).toISOString() } : null,
    setupCodePending: !!setup && now < setup.expiresAt,
    activeSessions: live,
    dir,
  };
}

function requireTty() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error("XATO: bu buyruq faqat interaktiv terminalda (TTY) ishlaydi. Terminal ilovasini ochib o'zingiz ishga tushiring.");
    process.exit(2);
  }
}

function readHidden(prompt) {
  return new Promise((resolve) => {
    process.stdout.write(prompt);
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let buf = "";
    const onData = (ch) => {
      for (const c of ch) {
        if (c === "\r" || c === "\n" || c === "\u0004") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.removeListener("data", onData);
          process.stdout.write("\n");
          resolve(buf);
          return;
        }
        if (c === "\u0003") {
          stdin.setRawMode(false);
          process.stdout.write("\n");
          process.exit(130);
        }
        if (c === "\u007f" || c === "\b") buf = buf.slice(0, -1);
        else buf += c;
      }
    };
    stdin.on("data", onData);
  });
}

async function main(argv) {
  const [cmd, arg] = argv;
  const dir = authDir();
  switch (cmd) {
    case "setup": {
      requireTty();
      const { code } = issueSetupCode(dir);
      console.log(`\nSozlash kodi:  ${code}\n(10 daqiqa amal qiladi, BIR MARTA ishlatiladi; 5 ta noto'g'ri urinishdan keyin bekor bo'ladi)\n`);
      console.log("Keyingi qadam:");
      console.log("  Brauzer:  http://localhost:4318/login -> \"Birinchi marta sozlash\" -> kodni kiriting -> \"Passkey qo'shish (Touch ID)\"");
      console.log("  Mac ilova: Commander oynasi -> \"Birinchi marta sozlash\" -> kodni kiriting -> \"Mac ilovani juftlash\"");
      return 0;
    }
    case "password": {
      requireTty();
      const p1 = await readHidden("Yangi parol (kamida 12 belgi, ko'p so'zli ibora yaxshi): ");
      const p2 = await readHidden("Takrorlang: ");
      if (p1 !== p2) throw new Error("Parollar mos kelmadi");
      await setPassword(dir, p1);
      console.log("Parol o'rnatildi (scrypt xesh, 0600 fayl). Eski sessiyalar tugatildi.");
      return 0;
    }
    case "status":
      console.log(JSON.stringify(status(dir), null, 2));
      return 0;
    case "revoke-sessions":
      writeJson(dir, "sessions.json", {});
      console.log("Barcha sessiyalar tugatildi.");
      return 0;
    case "remove":
      requireTty();
      removeMethod(dir, arg);
      console.log(`Olib tashlandi: ${arg}. Sessiyalar tugatildi.`);
      return 0;
    case "audit": {
      const n = Math.max(1, Math.min(500, Number(arg) || 30));
      try {
        const lines = readFileSync(path.join(dir, "audit.log"), "utf8").trim().split("\n");
        console.log(lines.slice(-n).join("\n"));
      } catch {
        console.log("(audit bo'sh)");
      }
      return 0;
    }
    default:
      console.error("Foydalanish: dashboard-auth.sh <setup|password|status|revoke-sessions|remove <password|passkeys|app>|audit [N]>");
      return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      console.error(`XATO: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    },
  );
}
