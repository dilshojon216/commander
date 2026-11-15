import { failure, json, originGuard, readBody } from "@/lib/auth/http";
import { passkeyRegisterOptions } from "@/lib/auth/service";
import { getAuthSettings } from "@/lib/auth/settings";

export const dynamic = "force-dynamic";

/** Passkey ro'yxatdan o'tkazish: CLI bergan bir martalik sozlash kodi SHART (lokal jarayon jimgina o'zinikini qo'sha olmaydi). */
export async function POST(request: Request) {
  const bad = originGuard(request);
  if (bad) return bad;
  const body = await readBody(request);
  if (body instanceof Response) return body;
  const r = await passkeyRegisterOptions(body.setupCode, Date.now(), getAuthSettings());
  return r.ok ? json({ options: r.options, challengeId: r.challengeId }) : failure(r);
}
