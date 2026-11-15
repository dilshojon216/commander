/**
 * Sirlarni maskalash (CLAUDE.md qoida 5). Notification matni, tool kiritmasi va boshqa erkin matn markazga ketishidan
 * oldin o'tadi. Bu eng so'nggi himoya emas (center ham redact qiladi), lekin sir tarmoqqa chiqmasin.
 * Tartib muhim: aniq shakllar (kalit/token) umumiy `KEY=value` qoidasidan oldin.
 *
 * REGEX XAVFSIZLIGI (M-17, review 2026-11-14): kirish hujumchi nazoratida (tool input, transcript, md fayl, git chiqishi).
 * Qoidalar: (1) har bir takrorlanuvchi sinf CHEGARALANGAN (`{0,N}`) yoki muvaffaqiyatli bo'lganda butun sinfni yeydi;
 * (2) sinfi `-`/`_` ni o'z ichiga olgan qoidalar `\b` o'rniga `(?<![A-Za-z0-9_-])` bilan ANKERLANADI (aks holda `a-a-a-...`
 * har belgida yangi boshlanish nuqtasi bo'lib, kvadratik bo'ladi); (3) "tugash" kutadigan qoidalar (PEM) yagona o'tishda
 * `|$` bilan tugaydi (har BEGIN uchun oxirigacha qayta skanerlamaydi); (4) kirish `REDACT_MAX_INPUT` dan oshsa, ARTIQCHA qismi
 * TASHLANADI (qayta yozilmaydi: redakt qilinmagan qism hech qachon chiqmaydi). 1 MB ~ <100 ms (redact.spec.ts benchmark).
 */

/** Bitta chaqiruvda qayta ishlanadigan eng katta kirish (belgi). Undan oshgani tashlanadi va belgilanadi. */
export const REDACT_MAX_INPUT = 2 * 1024 * 1024;
const TRUNCATED_MARK = '\n[REDACTED: input too large, remainder dropped]';

const SECRET_NAME =
  '(?:TOKEN|SECRET|PASSWORD|PASSWD|PWD|API[-_]?KEY|APIKEY|PRIVATE[-_]?KEY|ACCESS[-_]?KEY|CREDENTIALS?|AUTH|COOKIE|DSN|CONNECTION[-_]?STRING|DATABASE[-_]?URL)';
/** Nomning NAME'dan keyingi qismi (cheklangan: `TOKENTOKEN...` da kvadratik bo'lmasin). */
const NAME_TAIL = '[A-Z0-9_-]{0,64}';
/** `(?<![A-Za-z0-9_-])`: so'z/`-` ichidan boshlanmaydi (chiziqli skanerlash). */
const START = '(?<![A-Za-z0-9_-])';
/** URL ichidagi `user:pass@` (parol `/`, `@` ni o'z ichiga olishi mumkin: oxirgi `@` gacha, cheklangan). */
const URL_CREDS = /(?<![A-Za-z0-9+.-])([a-z][a-z0-9+.-]{0,31}:\/\/)[^\s/:@"']{1,128}:[^\s"']{1,256}@/gi;

/** Aniq shakldagi sirlar (kalit/token formatlari): umumiy `nom=qiymat` qoidasisiz, yolg'on ijobiy deyarli yo'q. */
const SHAPE_PATTERNS: Array<[RegExp, string]> = [
  // PEM/PGP: END bo'lmasa (kesilgan) oxirigacha; yagona o'tish.
  [/-----BEGIN [A-Z ]{0,40}PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z ]{0,40}PRIVATE KEY(?: BLOCK)?-----|$)/g, '[REDACTED KEY]'],
  [new RegExp(`${START}sk-ant-[A-Za-z0-9_-]{8,}`, 'g'), '[REDACTED]'],
  [new RegExp(`${START}sk-[A-Za-z0-9_-]{20,}`, 'g'), '[REDACTED]'],
  [new RegExp(`${START}(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}`, 'g'), '[REDACTED]'],
  [new RegExp(`${START}gh[pousr]_[A-Za-z0-9]{20,}`, 'g'), '[REDACTED]'],
  [new RegExp(`${START}github_pat_[A-Za-z0-9_]{20,}`, 'g'), '[REDACTED]'],
  [new RegExp(`${START}xox[abprs]-[A-Za-z0-9-]{10,}`, 'g'), '[REDACTED]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED]'],
  [new RegExp(`${START}AIza[0-9A-Za-z_-]{30,}`, 'g'), '[REDACTED]'],
  [new RegExp(`${START}npm_[A-Za-z0-9]{30,}`, 'g'), '[REDACTED]'],
  [new RegExp(`${START}cmdr_[A-Za-z0-9_-]{8,}`, 'g'), '[REDACTED]'],
  // Qo'shimcha provayder tokenlari (chat oqimi: transcript'da har xil narsa uchraydi)
  [new RegExp(`${START}(?:glpat|glptt|glrt)-[A-Za-z0-9_-]{16,}`, 'g'), '[REDACTED]'],
  [/\bsh(?:pat|pss|pca|ppa)_[A-Za-z0-9]{24,}/g, '[REDACTED]'],
  [/\bhf_[A-Za-z0-9]{30,}/g, '[REDACTED]'],
  [/\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g, '[REDACTED]'],
  [/\bdop_v1_[a-f0-9]{40,}/g, '[REDACTED]'],
  [/\bya29\.[A-Za-z0-9_-]{20,}/g, '[REDACTED]'],
  [/(?<![A-Za-z0-9])1\/\/0[A-Za-z0-9_-]{30,}/g, '[REDACTED]'], // Google refresh token
  [new RegExp(`${START}pypi-[A-Za-z0-9_-]{20,}`, 'g'), '[REDACTED]'],
  [/\bAGE-SECRET-KEY-[A-Z0-9]{20,}/g, '[REDACTED KEY]'],
  // Telegram bot token: yalang'och yoki URL ichida (`/bot<id>:AA...`: `bot` va raqam orasida \b yo'q)
  [/(?<![0-9])\d{8,10}:AA[A-Za-z0-9_-]{30,}/g, '[REDACTED]'],
  [new RegExp(`${START}(?:pplx|gsk|r8|xai)[-_][A-Za-z0-9]{24,}`, 'g'), '[REDACTED]'],
  // Webhook URL'lar (yo'lning o'zi sir)
  [/\bhooks\.slack\.com\/(?:services|workflows)\/[A-Za-z0-9/_-]{16,}/g, 'hooks.slack.com/[REDACTED]'],
  [/\bdiscord(?:app)?\.com\/api\/webhooks\/\d{6,}\/[A-Za-z0-9_-]{20,}/g, 'discord.com/api/webhooks/[REDACTED]'],
  // Yalang'och AWS secret key: aniq 40 belgi base64, aralash registr + raqam (git SHA/yo'llar tushmasin)
  [/(?<![A-Za-z0-9/+=_.-])(?=[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+=_.-]))(?=[A-Za-z0-9/+]*[A-Z])(?=[A-Za-z0-9/+]*[a-z])(?=[A-Za-z0-9/+]*[0-9])[A-Za-z0-9/+]{40}/g, '[REDACTED]'],
];

const JWT = new RegExp(`${START}eyJ[A-Za-z0-9_-]{8,}\\.eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]*`, 'g');

const GENERIC_PATTERNS: Array<[RegExp, string]> = [
  // CLI bayroqlari: --password x, --token=x, --user=u:p, -u user:pass
  [/(--(?:password|passwd|token|secret|api-?key|access-?key|auth-?token)(?:=|[ \t]+))(?:"[^"\n]{0,4096}"|'[^'\n]{0,4096}'|\S+)/gi, '$1[REDACTED]'],
  [/(\s(?:-u|--user)(?:[ \t]+|=))[^\s:]{1,256}:\S+/g, '$1[REDACTED]'],
  [/(\bsshpass[ \t]+(?:-[a-zA-Z]+[ \t]+){0,4}-p[ \t]*)(?:"[^"\n]{0,4096}"|'[^'\n]{0,4096}'|\S+)/g, '$1[REDACTED]'],
  [/(\b(?:docker|podman)[ \t]+login\b[^\n|;&]{0,200}?[ \t]-p[ \t]*)(?:"[^"\n]{0,4096}"|'[^'\n]{0,4096}'|\S+)/g, '$1[REDACTED]'],
  [/(\bmysql(?:dump|admin|pump)?\b[^\n|;&]{0,200}?[ \t]-p)[^\s-]\S*/g, '$1[REDACTED]'],
  [JWT, '[REDACTED JWT]'],
  // HTTP sarlavhalar: `Authorization: Bearer x`, `-H "X-Api-Key: x"`, `Cookie: a=b` (qo'shtirnoq/yangi qatorgacha)
  [/\b((?:proxy-)?authorization|x-api-key|x-auth-token|cookie|set-cookie)([ \t]*[:=][ \t]*)[^"'\r\n\\]+/gi, '$1$2[REDACTED]'],
  [/\b(Bearer)[ \t]+[A-Za-z0-9._~+/=-]{6,}/gi, '$1 [REDACTED]'],
  // URL ichidagi login:parol
  [URL_CREDS, '$1[REDACTED]@'],
  // JSON: "api_key": "..." | 123456 (kalit nomi sirli bo'lsa qiymat maskalanadi)
  [new RegExp(`("[A-Za-z0-9_-]{0,128}${SECRET_NAME}[A-Za-z0-9_-]{0,128}"[ \\t\\r\\n]*:[ \\t\\r\\n]*)(?:"(?:[^"\\\\]|\\\\.){0,8192}"|[0-9][^\\s,}\\]]{0,128})`, 'gi'), '$1"[REDACTED]"'],
  // Qator boshidagi `NAME=butun qator` / `name: butun qator` (.env, YAML; ko'p so'zli parol): qatorning qolgani
  [new RegExp(`^([ \\t]*(?:export[ \\t]+)?[A-Z0-9_.-]{0,64}${SECRET_NAME}${NAME_TAIL}[ \\t]*[=:][ \\t]*)(?!\\[REDACTED)[^\\r\\n]+$`, 'gim'), '$1[REDACTED]'],
  // .env / shell: NAME=value, NAME: value, export NAME="value with spaces". Nom oldi (prefiks) o'zgarmay qoladi.
  [new RegExp(`(${SECRET_NAME}${NAME_TAIL})[ \\t]*[=:][ \\t]*(?:"(?:[^"\\\\]|\\\\.){0,8192}"|'[^']{0,8192}'|\\S+)`, 'gi'), '$1=[REDACTED]'],
];

const PATTERNS: Array<[RegExp, string]> = [...SHAPE_PATTERNS, ...GENERIC_PATTERNS];

/** Katta kirishni cheklaydi: ortiqchasi tashlanadi (redakt qilinmagan qism chiqmaydi). */
function capInput(text: string): string {
  return text.length > REDACT_MAX_INPUT ? text.slice(0, REDACT_MAX_INPUT) + TRUNCATED_MARK : text;
}

export function redact(text: string): string {
  let out = capInput(text);
  for (const [re, repl] of PATTERNS) out = out.replace(re, repl);
  return out;
}

/**
 * Faqat aniq shakldagi sirlar + URL ichidagi login:parol. Oddiy so'zlarni (`token: ...`) buzmaydi: commit sarlavhalari
 * kabi ochiq, lekin tasodifan sir tushishi mumkin bo'lgan qisqa matnlar uchun (task 2.1).
 */
export function redactShapes(text: string): string {
  let out = capInput(text);
  for (const [re, repl] of SHAPE_PATTERNS) out = out.replace(re, repl);
  return out.replace(URL_CREDS, '$1[REDACTED]@');
}

/**
 * `.env` ko'rinishidagi QATORLAR (`NAME=value`, ixtiyoriy `export`): qiymat nomidan qat'i nazar maskalanadi.
 * Faqat tool natijalari va javob matni uchun (chat oqimi): `cat .env` chiqishi nomi "sirli" bo'lmagan qiymatlarni
 * ham (masalan `SMTP_HOST=...`) o'z ichiga oladi. Buyruq qatorida (`FOO=bar npm test`) ishlatilmaydi: u yerda
 * qator boshida emas.
 */
const DOTENV_LINE = /^([ \t]*(?:export[ \t]+)?[A-Za-z_][A-Za-z0-9_.]{0,128})=(?!\[REDACTED)(.+)$/gm;

/** Chat oqimi uchun: `redact()` + `.env` qatorlari. Kesish (truncate) bundan KEYIN bajariladi. */
export function redactChatText(text: string): string {
  return redact(text).replace(DOTENV_LINE, '$1=[REDACTED]');
}
