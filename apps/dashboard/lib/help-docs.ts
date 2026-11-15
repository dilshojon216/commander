import "server-only";
import { readFile } from "node:fs/promises";
import path from "node:path";

/** Yo'riqnoma hujjatlari: faqat shu ro'yxat (slug -> docs/ ichidagi fayl). Foydalanuvchi kiritgan yo'l fayl nomiga aylanmaydi. */
export const HELP_DOCS = {
  "remote-control": { file: "remote-control.md", title: "Masofaviy boshqaruvni yoqish" },
  "add-server": { file: "add-server.md", title: "Yangi server qo'shish" },
} as const;

export type HelpSlug = keyof typeof HELP_DOCS;

export function isHelpSlug(s: string): s is HelpSlug {
  return Object.hasOwn(HELP_DOCS, s);
}

/** Dashboard `apps/dashboard` dan (yoki repo ildizidan) ishga tushadi: ikkala joydagi `docs/` sinab ko'riladi. */
export function docsDirCandidates(cwd: string = process.cwd()): string[] {
  return [path.resolve(cwd, "../../docs"), path.resolve(cwd, "docs")];
}

export type HelpDocResult = { ok: true; title: string; content: string } | { ok: false; title: string };

/** Hujjatni o'qiydi; fayl topilmasa yoki o'qib bo'lmasa `ok: false` (sahifa xato bermaydi). */
export async function loadHelpDoc(slug: HelpSlug, cwd?: string): Promise<HelpDocResult> {
  const { file, title } = HELP_DOCS[slug];
  for (const dir of docsDirCandidates(cwd)) {
    try {
      const content = await readFile(path.join(dir, file), "utf8");
      return { ok: true, title, content };
    } catch {
      /* keyingi nomzod */
    }
  }
  return { ok: false, title };
}
