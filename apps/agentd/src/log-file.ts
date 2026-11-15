import { appendFileSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Fayl logi (oddiy aylanish): fayl `maxBytes` dan oshsa `<fayl>.1` ga ko'chadi (eskisi o'chiriladi), yangi fayl boshlanadi.
 * Jami <= ~2 x maxBytes. Windows'da (konsolsiz Scheduled Task) stderr ko'rinmagani uchun kerak. Yozish xatosi hech qachon
 * jarayonni yiqitmaydi (log yo'qolishi daemon'dan muhimroq emas). Sirlar chaqiruvchi tomonidan uzatilmaydi (logger.ts qoidasi).
 */
export function createRotatingFileWriter(file: string, maxBytes = 5 * 1024 * 1024): (line: string) => void {
  let size = 0;
  try {
    mkdirSync(dirname(file), { recursive: true });
    size = statSync(file).size;
  } catch {
    /* fayl hali yo'q */
  }
  return (line: string): void => {
    try {
      const data = line + '\n';
      if (size > 0 && size + Buffer.byteLength(data) > maxBytes) {
        try {
          unlinkSync(`${file}.1`);
        } catch {
          /* yo'q edi */
        }
        renameSync(file, `${file}.1`);
        size = 0;
      }
      appendFileSync(file, data, { mode: 0o600 });
      size += Buffer.byteLength(data);
    } catch {
      /* log yozib bo'lmadi: jim */
    }
  };
}
