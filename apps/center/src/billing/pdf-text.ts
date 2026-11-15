/**
 * PDF matni (pdfkit o'rnatilgan Helvetica = WinAnsi): o'zbek lotin belgilari (o', g' ...) apostrof bilan yoziladi, shuning uchun
 * Unicode apostroflar (U+2018/2019/02BB/02BC/0060) oddiy `'` ga keltiriladi; kirill harflar lotinga o'giriladi; WinAnsi'da yo'q
 * belgilar `?` bo'ladi (HTML/XLSX/CSV Unicode'ni saqlaydi). Boshqaruv belgilari olib tashlanadi.
 */

const CYR: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'yo', ж: 'j', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'x', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sh', ъ: "'", ы: 'i', ь: '', э: 'e', ю: 'yu', я: 'ya', ў: "o'", қ: 'q', ғ: "g'", ҳ: 'h',
};
const WINANSI_EXTRA = new Set(['–', '—', '•', '…', '“', '”', '€', '™', '‰']);

export function pdfSafe(text: string): string {
  let out = '';
  for (const ch of text.normalize('NFC')) {
    const lower = ch.toLowerCase();
    if (ch === '‘' || ch === '’' || ch === 'ʻ' || ch === 'ʼ' || ch === '`' || ch === '´') out += "'";
    else if (CYR[lower] !== undefined) out += ch === lower ? CYR[lower] : (CYR[lower]!.charAt(0).toUpperCase() + CYR[lower]!.slice(1));
    else if (ch === '\n') out += ' ';
    else {
      const c = ch.codePointAt(0)!;
      if ((c >= 0x20 && c <= 0x7e) || (c >= 0xa0 && c <= 0xff) || WINANSI_EXTRA.has(ch)) out += ch;
      else if (c < 0x20 || c === 0x7f) out += '';
      else out += '?';
    }
  }
  return out;
}
