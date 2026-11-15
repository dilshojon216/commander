import { json, sessionGuard } from "@/lib/auth/http";

export const dynamic = "force-dynamic";

/** Foydalanuvchi faoliyati (bosish/klaviatura): idle taymerini yangilaydi. Klient 1 daqiqada bir martadan ko'p chaqirmaydi. */
export function POST(request: Request) {
  const g = sessionGuard(request);
  if ("response" in g) return g.response;
  return json({ ok: true });
}
