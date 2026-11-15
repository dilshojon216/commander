import { bearerSecret, failure, loginSuccess, originGuardOptional } from "@/lib/auth/http";
import { appLogin } from "@/lib/auth/service";
import { getAuthSettings } from "@/lib/auth/settings";

export const dynamic = "force-dynamic";

/** Mac ilova (Touch ID'dan keyin) `Authorization: Bearer <ilova siri>` bilan sessiya oladi; cookie ni WKHTTPCookieStore'ga o'zi yozadi. */
export function POST(request: Request) {
  const bad = originGuardOptional(request);
  if (bad) return bad;
  const r = appLogin(bearerSecret(request), Date.now(), getAuthSettings());
  return r.ok ? loginSuccess(r) : failure(r);
}
