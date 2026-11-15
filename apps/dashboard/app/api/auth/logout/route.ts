import { audit } from "@/lib/auth/audit";
import { readSessionCookie } from "@/lib/auth/cookie";
import { logoutResponse, sessionGuard } from "@/lib/auth/http";
import { destroySession } from "@/lib/auth/sessions";

export const dynamic = "force-dynamic";

export function POST(request: Request) {
  const g = sessionGuard(request);
  if ("response" in g) return g.response;
  destroySession(readSessionCookie(request.headers.get("cookie")));
  audit("logout", { method: g.session.method });
  return logoutResponse();
}
