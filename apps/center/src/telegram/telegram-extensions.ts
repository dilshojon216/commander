/**
 * Telegram buyruqlari uchun yengil kengaytma reestri (3.2/3.3): boshqa modullar (hisobotlar va h.k.) `TelegramService`ga
 * bog'lanmasdan (modul sikli yo'q) o'z buyrug'ini ro'yxatdan o'tkazadi. Bot allowlist/identity tekshiruvidan KEYIN chaqiradi.
 * Qaytgan satrlar HTML xabarlar (har biri <= 4096 belgi bo'lishi kerak: `splitHtml` ishlating).
 */
export type TelegramCommandHandler = (args: string, chatId: string) => Promise<string[]>;

const handlers = new Map<string, TelegramCommandHandler>();

export const telegramExtensions = {
  register(name: string, handler: TelegramCommandHandler): () => void {
    handlers.set(name, handler);
    return () => {
      if (handlers.get(name) === handler) handlers.delete(name);
    };
  },
  get(name: string): TelegramCommandHandler | undefined {
    return handlers.get(name);
  },
};

export const TELEGRAM_MAX_MESSAGE = 4096;

/**
 * HTML matnni <= `max` belgili bo'laklarga bo'ladi: faqat qator chegarasida; ochiq `<b>`, `<i>`, `<code>`, `<pre>` teglar
 * bo'lak oxirida yopilib, keyingisida qayta ochiladi. Juda uzun bitta qator belgi bo'yicha kesiladi (teg/entity o'rtasida emas).
 */
export function splitHtml(text: string, max: number = TELEGRAM_MAX_MESSAGE): string[] {
  if (text.length <= max) return [text];
  const TAGS = ['b', 'i', 'code', 'pre', 'u', 's'];
  const parts: string[] = [];
  let cur = '';
  let open: string[] = [];
  const closing = (): string => [...open].reverse().map((t) => `</${t}>`).join('');
  const opening = (): string => open.map((t) => `<${t}>`).join('');
  const track = (line: string): void => {
    for (const m of line.matchAll(/<(\/?)(b|i|code|pre|u|s)>/g)) {
      const tag = m[2]!;
      if (m[1] === '') open.push(tag);
      else {
        const i = open.lastIndexOf(tag);
        if (i !== -1) open.splice(i, 1);
      }
    }
  };
  void TAGS;
  const flush = (): void => {
    if (cur.length > 0) parts.push(cur + closing());
    cur = opening();
  };
  const room = (): number => max - closing().length;
  for (const rawLine of text.split('\n')) {
    let line = rawLine;
    for (;;) {
      const sep = cur.length === 0 || cur === opening() ? '' : '\n';
      if (cur.length + sep.length + line.length <= room()) {
        cur += sep + line;
        track(line);
        break;
      }
      if (cur.length > opening().length) {
        flush();
        continue;
      }
      // bitta qator o'zi sig'maydi: kesamiz (entity/teg o'rtasida emas)
      let cut = Math.max(1, room() - cur.length);
      const slice = line.slice(0, cut);
      const lt = slice.lastIndexOf('<');
      const amp = slice.lastIndexOf('&');
      if (lt > slice.lastIndexOf('>') && lt > 0) cut = lt;
      else if (amp > slice.lastIndexOf(';') && amp > 0) cut = amp;
      const head = line.slice(0, cut);
      cur += head;
      track(head);
      line = line.slice(cut);
      flush();
    }
  }
  if (cur.length > opening().length || parts.length === 0) parts.push(cur + closing());
  return parts;
}
