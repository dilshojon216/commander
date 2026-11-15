import { z } from 'zod';

/**
 * Keyset sahifalash kursori: `[tsMikrosekund(ISO satr), id]` ning base64url JSON'i. Vaqt SQL'dan matn
 * sifatida olinadi (JS Date mikrosekundni yo'qotadi: bir xil ms ichidagi qatorlar tushib qolmasin).
 */
const CursorSchema = z.tuple([z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/), z.string().min(1).max(64)]);

export interface Cursor {
  ts: string;
  id: string;
}

export const encodeCursor = (c: Cursor): string => Buffer.from(JSON.stringify([c.ts, c.id])).toString('base64url');

/** Yaroqsiz kursor `null` (chaqiruvchi 400 qaytaradi). */
export function decodeCursor(raw: string): Cursor | null {
  try {
    const parsed = CursorSchema.safeParse(JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')));
    return parsed.success ? { ts: parsed.data[0], id: parsed.data[1] } : null;
  } catch {
    return null;
  }
}

/** SQL ifodasi: timestamptz -> mikrosekund aniqlikdagi UTC satr (`encodeCursor` formati). */
export const cursorTsSql = (column: string): string => `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
