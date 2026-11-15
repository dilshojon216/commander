import { appElevationToken } from "@/lib/auth/service";
import { bearerSecret, failure, json, originGuardOptional } from "@/lib/auth/http";

export const dynamic = "force-dynamic";

export function POST(request: Request) {
  const bad = originGuardOptional(request);
  if (bad) return bad;
  const r = appElevationToken(bearerSecret(request), Date.now());
  return r.ok ? json({ ok: true, token: r.token, ttlMs: 30_000 }) : failure(r);
}
