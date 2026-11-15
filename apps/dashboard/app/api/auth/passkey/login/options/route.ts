import { failure, json, originGuard } from "@/lib/auth/http";
import { passkeyLoginOptions } from "@/lib/auth/service";
import { getAuthSettings } from "@/lib/auth/settings";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const bad = originGuard(request);
  if (bad) return bad;
  const r = await passkeyLoginOptions(Date.now(), getAuthSettings());
  return r.ok ? json({ options: r.options, challengeId: r.challengeId }) : failure(r);
}
