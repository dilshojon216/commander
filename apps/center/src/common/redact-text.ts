/**
 * Erkin matndagi sirlarni maskalash (CLAUDE.md qoida 5). agentd o'z tomonida redact() qiladi; bu markazdagi
 * XAVFSIZLIK TO'RI: agentd xato qilsa yoki eskirgan bo'lsa ham, aniq sirlar DB'ga/klientlarga tushmasin.
 * To'liq himoya EMAS (regex): xom kiritma baribir markazga yuborilmasligi shart.
 *
 * XAVFSIZLIK (H-03, ReDoS): bu funksiya hujumchi boshqaradigan matnda ishlaydi va event loop'ni bloklay olmaydi.
 *  - Kiritma `REDACT_MAX_INPUT` dan oshsa KESILADI (qolgani tashlab yuboriladi: redaktsiya uchun xavfsiz tomon);
 *  - barcha regexlar chiziqli vaqtli: `+`/`*` o'rniga cheklangan kvantifikatorlar, boshlanish nuqtalari lookbehind bilan
 *    "so'z boshi"ga qisqartirilgan (bitta uzun so'zdan har pozitsiyada qayta urinish yo'q);
 *  - `KEY=value` qoidasi regex emas, qo'lda skaner (qiymatni regex yutmaydi).
 * Benchmark: `redact-text.bench.spec.ts` (64 KB adversarial kiritma < 50 ms).
 *
 * H-04: `KEY=value` faqat qiymatning HARFLI qismini maskalaydi. `$(...)`, `` `...` ``, `${...}` va `$VAR` bo'laklari
 * (kod!) ko'rinib turadi, shunda `API_TOKEN="$(curl x | sh)"` karta/DB'da `API_TOKEN=$(curl x | sh)` bo'lib qoladi.
 */

/** Shundan uzun matn kesiladi (qolgani tashlanadi). Config fayllar <= 256 KB, prompt/plan undan kichik. */
export const REDACT_MAX_INPUT = 1_048_576;
export const REDACTED_MARK = '[REDACTED]';
const CUT_MARK = '…[kesildi: juda uzun]';

/** Kalit nomi belgilari (so'z boshini aniqlash uchun lookbehind ham shu sinf). */
const NAME_CH = 'A-Za-z0-9_.-';
const SECRET_WORD = '(?:token|secret|passw(?:or)?d|passwd|api[_-]?key|private[_-]?key|credential)';

/** Aniq shakldagi sirlar. Hammasi chiziqli (muvaffaqiyatda butun qatorni yeydi yoki chegaralangan). */
const PATTERNS: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z ]{0,40}PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z ]{0,40}PRIVATE KEY(?: BLOCK)?-----|$)/g, '[REDACTED KEY]'],
  [/(?<![A-Za-z0-9_])sk-ant-[A-Za-z0-9_-]{8,}/g, '[REDACTED]'],
  [/(?<![A-Za-z0-9_])sk-[A-Za-z0-9_-]{20,}/g, '[REDACTED]'],
  [/(?<![A-Za-z0-9_])(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}/g, '[REDACTED]'],
  [/(?<![A-Za-z0-9_])gh[pousr]_[A-Za-z0-9]{20,}/g, '[REDACTED]'],
  [/(?<![A-Za-z0-9_])github_pat_[A-Za-z0-9_]{20,}/g, '[REDACTED]'],
  [/(?<![A-Za-z0-9_])(?:glpat|glptt|glrt)-[A-Za-z0-9_-]{16,}/g, '[REDACTED]'],
  [/(?<![A-Za-z0-9_])xox[abprs]-[A-Za-z0-9-]{10,}/g, '[REDACTED]'],
  [/https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]{20,}/g, '[REDACTED]'],
  [/(?<![A-Za-z0-9_])(?:AKIA|ASIA)[0-9A-Z]{16}(?![A-Za-z0-9_])/g, '[REDACTED]'],
  [/(?<![A-Za-z0-9_])AIza[0-9A-Za-z_-]{30,}/g, '[REDACTED]'],
  [/(?<![A-Za-z0-9_])npm_[A-Za-z0-9]{30,}/g, '[REDACTED]'],
  [/(?<![A-Za-z0-9_])pypi-[A-Za-z0-9_-]{30,}/g, '[REDACTED]'],
  [/(?<![A-Za-z0-9_])hf_[A-Za-z0-9]{30,}/g, '[REDACTED]'],
  [/(?<![A-Za-z0-9_])SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g, '[REDACTED]'],
  [/(?<![A-Za-z0-9_])ya29\.[A-Za-z0-9_-]{20,}/g, '[REDACTED]'],
  [/(?<![A-Za-z0-9_])1\/\/0[A-Za-z0-9_-]{30,}/g, '[REDACTED]'],
  [/(?<![A-Za-z0-9_])cmdr_[A-Za-z0-9_-]{16,}/g, '[REDACTED]'],
  // Telegram bot token (URL ichida `bot123:AA...` ham)
  [/(?<![0-9])[0-9]{8,10}:AA[A-Za-z0-9_-]{30,}/g, '[REDACTED]'],
  // JWT: lookbehind bilan har "so'z"dan bir marta; segmentlar chegaralangan (kvadratik backtracking yo'q)
  [/(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,4096}\.eyJ[A-Za-z0-9_-]{8,4096}\.[A-Za-z0-9_-]{8,4096}/g, '[REDACTED JWT]'],
  [/(?<![A-Za-z0-9_])(Bearer|Basic)[ \t]{1,32}[A-Za-z0-9._~+/=-]{12,4096}/gi, '$1 [REDACTED]'],
  // URL ichidagi login:parol (parolda `@` bo'lishi mumkin: oxirgi `@`gacha, 200 belgigacha; `/` URL qismini ajratadi)
  [/(:\/\/[^\s/:@]{1,128}:)[^\s/]{1,200}@/g, '$1[REDACTED]@'],
  // CLI bayroqlari: --password x, --token=x, --user=a:b, -p<pass> (sshpass/mysql), docker login -p
  [/(--(?:password|passwd|token|secret|api-?key|access-?key|auth-?token)(?:=|[ \t]{1,8}))(?:"[^"\n]{0,512}"|'[^'\n]{0,512}'|[^\s]{1,512})/gi, '$1[REDACTED]'],
  [/(--user(?:=|[ \t]{1,8}))[^\s:]{1,128}:[^\s]{1,256}/g, '$1[REDACTED]'],
  [/(?<![A-Za-z0-9_-])(sshpass[ \t]{1,8}-p[ \t]{0,4})(?:"[^"\n]{0,256}"|'[^'\n]{0,256}'|[^\s]{1,256})/g, '$1[REDACTED]'],
  [/(?<![A-Za-z0-9_-])((?:mysql|mysqldump|mariadb)[^\n|;&]{0,120}?[ \t]-p)[^\s-][^\s]{0,255}/g, '$1[REDACTED]'],
];

const KEY_RE = new RegExp(
  `(?<![${NAME_CH}])["']?[${NAME_CH}]{0,100}?${SECRET_WORD}[${NAME_CH}]{0,100}["']?[ \\t]{0,8}[=:][ \\t]{0,8}`,
  'gi',
);

const VALUE_MAX = 4096;
const MAX_NEST = 3;

const isSpace = (c: string): boolean => c === ' ' || c === '\t' || c === '\n' || c === '\r';

/** `$(` dan boshlab muvozanatli `)` gacha (qo'shtirnoqlarni hisobga olmay; chegaralangan). Topilmasa -1. */
function matchParen(s: string, start: number, limit: number): number {
  let depth = 0;
  for (let i = start; i < limit; i += 1) {
    const c = s[i];
    if (c === '(') depth += 1;
    else if (c === ')') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/**
 * Qiymatni skanerlaydi: [literal | kod] bo'laklar. Kod bo'lagi (`$(..)`, `` `..` ``, `${..}`, `$VAR`) ko'rinadi.
 * Qaytaradi: qiymat tugagan indeks va chiqish (literal bo'laklar ketma-ket bitta `[REDACTED]`ga aylanadi).
 */
function scanValue(s: string, from: number, depth: number): { end: number; out: string } {
  const limit = Math.min(s.length, from + VALUE_MAX);
  let i = from;
  let quote: '"' | "'" | null = null;
  if (s[i] === '"' || s[i] === "'") {
    quote = s[i] as '"' | "'";
    i += 1;
  }
  if (quote === null && s.startsWith('[REDACTED', i)) {
    // allaqachon maskalangan (agentd): qayta maskalamaymiz
    const close = s.indexOf(']', i);
    if (close !== -1 && close - i <= 24) return { end: close + 1, out: s.slice(i, close + 1) };
  }
  let out = '';
  let lit = false;
  let masked = false;
  const flushLit = (): void => {
    if (lit) {
      out += REDACTED_MARK;
      lit = false;
      masked = true;
    }
  };
  const keep = (code: string): string => {
    const r = keepCode(code, depth);
    if (r !== code) masked = true;
    return r;
  };
  const unquotedStop = (c: string): boolean => isSpace(c) || c === ',' || c === ';' || c === '&' || c === '|' || c === '<' || c === '>' || c === ')' || c === '"' || c === "'";
  while (i < limit) {
    const c = s[i]!;
    if (quote !== null) {
      if (c === quote) {
        i += 1;
        break;
      }
      if (c === '\n') break; // yopilmagan qo'shtirnoq: qator oxirigacha
    } else if (unquotedStop(c)) {
      break;
    }
    if (quote !== "'" && c === '$' && s[i + 1] === '(') {
      const e = matchParen(s, i + 1, limit);
      if (e !== -1) {
        flushLit();
        out += keep(s.slice(i, e));
        i = e;
        continue;
      }
    }
    if (quote !== "'" && c === '`') {
      const e = s.indexOf('`', i + 1);
      if (e !== -1 && e < limit) {
        flushLit();
        out += keep(s.slice(i, e + 1));
        i = e + 1;
        continue;
      }
    }
    if (quote !== "'" && c === '$' && s[i + 1] === '{') {
      const e = s.indexOf('}', i + 2);
      if (e !== -1 && e < limit) {
        flushLit();
        out += s.slice(i, e + 1);
        i = e + 1;
        continue;
      }
    }
    if (quote !== "'" && c === '$' && /[A-Za-z_]/.test(s[i + 1] ?? '')) {
      let e = i + 2;
      while (e < limit && /[A-Za-z0-9_]/.test(s[e]!)) e += 1;
      flushLit();
      out += s.slice(i, e);
      i = e;
      continue;
    }
    lit = true;
    i += 1;
  }
  flushLit();
  // Qiymat VALUE_MAX dan uzun bo'lsa qolgan qismi ham sir bo'lishi mumkin: oxirigacha (so'z chegarasigacha) yutiladi.
  if (i >= limit && limit < s.length && quote === null) {
    while (i < s.length && !unquotedStop(s[i]!)) i += 1;
    if (!out.endsWith(REDACTED_MARK)) out += REDACTED_MARK;
    masked = true;
  }
  // Hech narsa maskalanmagan (faqat o'zgaruvchi/almashtirish): asl matn (qo'shtirnoqlar bilan) o'zgarishsiz qoladi.
  return { end: i, out: masked ? out : s.slice(from, i) };
}

function keepCode(code: string, depth: number): string {
  return depth >= MAX_NEST ? REDACTED_MARK : redactKeyValues(code, depth + 1);
}

/** Chiziqli `KEY=value` maskalash (regex qiymatni yemaydi). */
function redactKeyValues(text: string, depth = 0): string {
  KEY_RE.lastIndex = 0;
  let out = '';
  let last = 0;
  for (;;) {
    const m = KEY_RE.exec(text);
    if (m === null) break;
    const keyEnd = m.index + m[0].length;
    const { end, out: val } = scanValue(text, keyEnd, depth);
    out += text.slice(last, keyEnd) + val;
    last = end;
    KEY_RE.lastIndex = Math.max(end, keyEnd);
    if (m[0].length === 0) KEY_RE.lastIndex += 1;
  }
  return last === 0 ? text : out + text.slice(last);
}

export function redactText(text: string): string {
  let out = text;
  if (out.length > REDACT_MAX_INPUT) out = out.slice(0, REDACT_MAX_INPUT) + CUT_MARK;
  for (const [re, repl] of PATTERNS) out = out.replace(re, repl);
  return redactKeyValues(out);
}

/** Redakt qilib, `maxChars` dan oshsa kesadi (oxiriga `…[truncated]`). Kesish redaktdan KEYIN: sir yarim qolib ketmasin. */
export function redactAndCap(text: string, maxChars: number): string {
  const clean = redactText(text);
  const marker = '…[truncated]';
  return clean.length <= maxChars ? clean : `${clean.slice(0, Math.max(0, maxChars - marker.length))}${marker}`;
}
