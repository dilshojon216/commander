/**
 * Dashboard qayta deploy qilinganda ochiq oyna (brauzer yoki Mac ilovasi) eski build'ning chunk'larini so'raydi va
 * `ChunkLoadError` bilan yiqiladi (2026-11-14: menyular ochilmay qolgan). Bunday xatoda sahifani to'liq qayta yuklash
 * yangi build'ni oladi. Cheksiz sikl bo'lmasin: bir yo'l uchun `RELOAD_WINDOW_MS` ichida faqat bir marta.
 */
export const RELOAD_WINDOW_MS = 30_000;
const KEY = "commander.chunkReloadAt";

export function isChunkLoadError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const { name, message } = error as { name?: unknown; message?: unknown };
  if (name === "ChunkLoadError") return true;
  const m = typeof message === "string" ? message : "";
  return /Failed to load chunk|Loading chunk [\w-]+ failed|Loading CSS chunk|Failed to fetch dynamically imported module|Importing a module script failed/i.test(m);
}

/** Sof qaror: oxirgi qayta yuklash yozuvi (`path|ts`) bo'yicha hozir qayta yuklash kerakmi. */
export function shouldReload(lastRecord: string | null, path: string, now: number): boolean {
  if (!lastRecord) return true;
  const sep = lastRecord.lastIndexOf("|");
  const lastPath = lastRecord.slice(0, sep);
  const ts = Number(lastRecord.slice(sep + 1));
  if (lastPath !== path || !Number.isFinite(ts)) return true;
  return now - ts > RELOAD_WINDOW_MS;
}

/** Chunk xatosi bo'lsa va yaqinda qayta yuklanmagan bo'lsa — to'liq qayta yuklaydi. Qayta yuklansa `true`. */
export function reloadOnChunkError(error: unknown): boolean {
  if (typeof window === "undefined" || !isChunkLoadError(error)) return false;
  const path = window.location.pathname + window.location.search;
  const now = Date.now();
  let last: string | null = null;
  try {
    last = window.sessionStorage.getItem(KEY);
  } catch {
    // sessionStorage yopiq bo'lsa ham bir marta qayta yuklaymiz
  }
  if (!shouldReload(last, path, now)) return false;
  try {
    window.sessionStorage.setItem(KEY, `${path}|${now}`);
  } catch {
    // e'tiborsiz
  }
  window.location.reload();
  return true;
}
