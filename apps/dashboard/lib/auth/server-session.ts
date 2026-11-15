import "server-only";
import { headers } from "next/headers";
import { readSessionCookie } from "./cookie";
import { lookupSession } from "./sessions";
import type { SessionView } from "./sessions";
import { getAuthSettings } from "./settings";

/** Server komponentlar uchun: joriy sessiya (idle taymerini yangilamaydi) yoki null. */
export async function requireSessionOrNull(): Promise<SessionView | null> {
  const h = await headers();
  const found = lookupSession(readSessionCookie(h.get("cookie")), Date.now(), getAuthSettings(), { touch: false });
  return found.ok ? found.session : null;
}
