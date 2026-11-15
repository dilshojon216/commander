import { failure, json, readBody, sessionGuard } from "@/lib/auth/http";
import { passkeyElevate } from "@/lib/auth/service";
import { getAuthSettings } from "@/lib/auth/settings";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const g = sessionGuard(request);
  if ("response" in g) return g.response;
  const body = await readBody(request);
  if (body instanceof Response) return body;
  const r = await passkeyElevate(g.session, { challengeId: body.challengeId, response: body.response }, Date.now(), getAuthSettings());
  return r.ok ? json({ ok: true, elevatedUntil: r.elevatedUntil }) : failure(r);
}
