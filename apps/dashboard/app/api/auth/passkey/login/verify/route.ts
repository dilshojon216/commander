import { failure, loginSuccess, originGuard, readBody } from "@/lib/auth/http";
import { passkeyLogin } from "@/lib/auth/service";
import { getAuthSettings } from "@/lib/auth/settings";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const bad = originGuard(request);
  if (bad) return bad;
  const body = await readBody(request);
  if (body instanceof Response) return body;
  const r = await passkeyLogin({ challengeId: body.challengeId, response: body.response }, Date.now(), getAuthSettings());
  return r.ok ? loginSuccess(r) : failure(r);
}
