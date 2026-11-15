import { failure, json, originGuardOptional, readBody } from "@/lib/auth/http";
import { appPair } from "@/lib/auth/service";

export const dynamic = "force-dynamic";

/** Mac ilovani juftlash: CLI bergan bir martalik sozlash kodi bilan; ilova siri BIR MARTA qaytariladi (ilova uni Keychain'ga yozadi). */
export async function POST(request: Request) {
  const bad = originGuardOptional(request);
  if (bad) return bad;
  const body = await readBody(request);
  if (body instanceof Response) return body;
  const r = appPair(body.setupCode, body.name, Date.now());
  return r.ok ? json({ ok: true, secret: r.secret }) : failure(r);
}
