import { failure, json, readBody, sessionGuard } from "@/lib/auth/http";
import { appElevate } from "@/lib/auth/service";
import { getAuthSettings } from "@/lib/auth/settings";

export const dynamic = "force-dynamic";

/** Mac ilova Touch ID'dan keyin bergan bir martalik token bilan (sahifa JS uni native ko'prikdan oladi). */
export async function POST(request: Request) {
  const g = sessionGuard(request);
  if ("response" in g) return g.response;
  const body = await readBody(request);
  if (body instanceof Response) return body;
  const r = appElevate(g.session, body.token, Date.now(), getAuthSettings());
  return r.ok ? json({ ok: true, elevatedUntil: r.elevatedUntil }) : failure(r);
}
