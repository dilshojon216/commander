import { authorize, denyResponse } from "@/lib/auth/guard";
import { json } from "@/lib/auth/http";
import { availableMethods } from "@/lib/auth/service";
import { getAuthSettings } from "@/lib/auth/settings";

export const dynamic = "force-dynamic";

/** Joriy sessiya (fon so'rovi: idle taymerini yangilamaydi). CSRF tokeni va ko'tarilish muddati shu yerdan olinadi. */
export function GET(request: Request) {
  const g = authorize(request, { touch: false });
  if (!g.ok) return denyResponse(g);
  const s = getAuthSettings();
  return json({
    authenticated: true,
    csrf: g.session.csrf,
    method: g.session.method,
    elevatedUntil: g.session.elevatedUntil,
    expiresAt: g.session.expiresAt,
    elevationMs: s.elevationMs,
    methods: availableMethods(),
  });
}
