/**
 * `TELEGRAM_ALLOWED_CHAT_IDS` (vergul bilan) ni tekshiradi. Faqat shaxsiy chatlar (musbat butun son):
 * bot guruhlarga qo'shilmaydi (PLAN 9, `/setjoingroups disable`), shu sabab manfiy id rad etiladi.
 */
export const CHAT_ID_RE = /^[1-9]\d{0,14}$/;

export function isChatId(value: string): boolean {
  return CHAT_ID_RE.test(value);
}

/** Bo'sh/aniqlanmagan qiymat -> []. Yaroqsiz element -> xato (sozlama xatosi jim o'tib ketmasin). */
export function parseChatIds(raw: string | undefined | null): string[] {
  if (raw === undefined || raw === null) return [];
  const out = new Set<string>();
  for (const part of raw.split(',')) {
    const id = part.trim();
    if (id === '') continue;
    if (!isChatId(id)) throw new Error('TELEGRAM_ALLOWED_CHAT_IDS must be a comma-separated list of positive private chat ids');
    out.add(id);
  }
  return [...out];
}
