import { failure, json, sessionGuard } from "@/lib/auth/http";
import { passkeyElevateOptions } from "@/lib/auth/service";
import { getAuthSettings } from "@/lib/auth/settings";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const g = sessionGuard(request);
  if ("response" in g) return g.response;
  const r = await passkeyElevateOptions(g.session, Date.now(), getAuthSettings());
  return r.ok ? json({ options: r.options, challengeId: r.challengeId }) : failure(r);
}
