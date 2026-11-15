import { redactText } from '../../common/redact-text.js';

/**
 * Mijoz hisoboti matn tozalagichi (6.8): MIJOZ KO'RADIGAN har bir matn (vazifa sarlavhasi, kunlik xulosa qatori, loyiha nomi)
 * shu funksiyadan o'tadi. Maqsad: kod, fayl yo'li, commit xeshi, mashina nomi, sir, havola, email, IP, ichki host nomi
 * HECH QACHON chiqmasin. Bu to'liq kafolat emas (regex): shuning uchun model faqat oq ro'yxatdagi maydonlardan iborat va
 * oxirida `leak-check.ts` natijani qayta tekshiradi (topilsa generatsiya TO'XTAYDI).
 * Hamma regexlar chiziqli (ichma-ich kvantifikatorsiz); kiritma `SANITIZE_MAX_INPUT` dan keyin kesiladi.
 */

export const SANITIZE_MAX_INPUT = 4000;

export interface SanitizeContext {
  /** Taqiqlangan so'zlar/iboralar (mashina nomlari, loyiha yo'llari ...). Katta-kichik harfga e'tiborsiz. */
  forbidden: readonly string[];
}

const CODE_EXT = 'ts|tsx|js|jsx|mjs|cjs|json|jsonc|md|mdx|yml|yaml|py|go|rs|java|kt|kts|swift|dart|sh|bash|zsh|sql|toml|lock|css|scss|sass|html|vue|svelte|rb|php|c|h|cpp|hpp|cs|gradle|xml|ini|conf|cfg|log|pem|key|crt|env|txt|csv|plist|sum|mod';
const ROOT_DIRS = 'src|lib|libs|app|apps|docs|test|tests|spec|node_modules|dist|build|packages|scripts|public|assets|components|pages|migrations|config|etc|usr|var|tmp|opt|home|bin|Users|Library|mnt|srv|root|proc|dev';

const RULES: Array<[RegExp, string]> = [
  // kod bloklari (yopilmagan bo'lsa ham oxirigacha)
  [/```[\s\S]*?(?:```|$)/g, ' '],
  // HTML teglar (matn baribir escape qilinadi; bu qo'shimcha qatlam)
  [/<\/?[A-Za-z][^<>]{0,200}>/g, ' '],
  // havola, email, host, IP, UUID
  [/\b[a-z][a-z0-9+.-]{1,12}:\/\/[^\s<>"')\]]{1,300}/gi, ' '],
  [/\bwww\.[^\s<>"')\]]{1,200}/gi, ' '],
  [/[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,255}\.[A-Za-z]{2,24}/g, ' '],
  [/\b[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){0,6}\.(?:ts\.net|local|lan|internal|home|corp|intra)\b/gi, ' '],
  [/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d{1,5})?\b/g, ' '],
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, ' '],
  // Windows yo'llari (disk va UNC)
  [/\b[A-Za-z]:\\[^\s"'<>|]{0,260}/g, ' '],
  [/\\\\[^\s\\"'<>|]{1,64}\\[^\s"'<>|]{0,260}/g, ' '],
  // unix yo'llari: ~/x, ~, /a/b, ildiz papka
  [/(?<![\w/.-])~(?:\/[^\s"'<>()[\]{}|,;:]{0,200}){1,40}/g, ' '],
  [/(?<![\w/.:-])\/(?:[^\s"'<>()[\]{}|,;:/]{1,100}\/){1,40}[^\s"'<>()[\]{}|,;:/]{0,100}/g, ' '],
  [new RegExp(`(?<![\\w/.-])/(?:${ROOT_DIRS})(?![\\w-])`, 'g'), ' '],
  // nisbiy yo'l: 2+ qism, yoki fayl kengaytmali, yoki ma'lum papkadan boshlanuvchi
  [/(?<![\w./-])[\w.@+-]{1,100}(?:\/[\w.@+-]{1,100}){2,40}/g, ' '],
  [new RegExp(`(?<![\\w./-])[\\w@+-]{1,100}(?:/[\\w@+-]{1,100})*/[\\w@+-]{1,100}\\.(?:${CODE_EXT})\\b`, 'gi'), ' '],
  [new RegExp(`(?<![\\w./-])(?:${ROOT_DIRS})/[\\w.@+-]{1,100}`, 'g'), ' '],
  // yalang'och fayl nomlari va nuqtali fayllar
  [new RegExp(`(?<![\\w-])[\\w@+-]{1,100}(?:\\.[\\w@+-]{1,30}){0,3}\\.(?:${CODE_EXT})(?![\\w-])`, 'gi'), ' '],
  [/(?<![\w.])\.(?:env|git\w{0,20}|npmrc|ssh|aws|claude|docker\w{0,20}|bashrc|zshrc|profile)(?:\.[\w-]{1,20})?(?![\w-])/g, ' '],
  // commit xeshi: 7-40 hex (kamida bitta raqam) yoki 12+ hex; uzun tasodifiy tokenlar
  [/(?<![0-9A-Za-z])(?=[0-9a-f]{7,40}(?![0-9A-Za-z]))(?=[0-9]*[a-f])(?=[a-f]*[0-9])[0-9a-f]{7,40}(?![0-9A-Za-z])/gi, ' '],
  [/(?<![0-9A-Za-z])[0-9a-f]{12,64}(?![0-9A-Za-z])/gi, ' '],
  [/(?<![A-Za-z0-9])[A-Za-z0-9+/_=-]{32,}(?![A-Za-z0-9])/g, ' '],
  // sir qiymati olib tashlangach qolgan `NOM=` qoldig'i
  [/(?<![\w-])[A-Za-z_][\w.-]{0,60}=(?=\s|$)/g, ' '],
  // uslub belgilari
  [/\[REDACTED(?: KEY)?\]/g, ' '],
  [/[`]+/g, ''],
  [/\*\*|__|~~/g, ''],
];

/** Yo'naltiruvchi/boshqaruvchi/ko'rinmas Unicode (matnni yashirib qo'yish, RTL aldovi). */
const INVISIBLE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb]/g;
const EMPTY_PAIRS = /\(\s*\)|\[\s*\]|\{\s*\}|<\s*>|"\s*"|'\s*'/g;

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Taqiqlangan iboralarni olib tashlaydi (qisqa <3 belgili iboralar e'tiborsiz: oddiy so'zlarni yemasin). */
export function stripForbidden(text: string, forbidden: readonly string[]): string {
  let out = text;
  const list = [...new Set(forbidden.map((f) => f.trim()).filter((f) => f.length >= 3))].sort((a, b) => b.length - a.length);
  for (const f of list) out = out.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(f)}(?![\\p{L}\\p{N}])`, 'giu'), ' ');
  return out;
}

export function sanitizeClientText(raw: string, ctx: SanitizeContext, maxChars: number): string {
  let t = raw.length > SANITIZE_MAX_INPUT ? raw.slice(0, SANITIZE_MAX_INPUT) : raw;
  t = t.normalize('NFKC').replace(INVISIBLE, ' ');
  t = redactText(t);
  t = stripForbidden(t, ctx.forbidden);
  for (let pass = 0; pass < 2; pass++) for (const [re, rep] of RULES) t = t.replace(re, rep);
  t = stripForbidden(t, ctx.forbidden);
  t = t.replace(EMPTY_PAIRS, ' ').replace(/\s+/g, ' ');
  t = t.replace(/^[\s:;,\-–—|•·*#>]+/, '').replace(/[\s:;,\-–—|•·(\[{<]+$/, '').trim();
  if (t.length > maxChars) t = `${t.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
  return t;
}

/** Ko'p qatorli matn (kunlik xulosa): har qator alohida tozalanadi, bo'shlari tashlanadi, markerlar olib tashlanadi. */
export function sanitizeLines(raw: string, ctx: SanitizeContext, opts: { maxLines: number; maxChars: number }): string[] {
  const out: string[] = [];
  for (const line of raw.slice(0, SANITIZE_MAX_INPUT * 4).split(/\r?\n/)) {
    const cleaned = sanitizeClientText(line.replace(/^\s*(?:[-*+•]|\d{1,3}[.)])\s+/, '').replace(/^\s*#{1,6}\s+/, ''), ctx, opts.maxChars);
    if (cleaned.length >= 3 && /[\p{L}\p{N}]/u.test(cleaned) && !out.includes(cleaned)) out.push(cleaned);
    if (out.length >= opts.maxLines) break;
  }
  return out;
}
