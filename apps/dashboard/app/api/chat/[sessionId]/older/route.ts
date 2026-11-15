import { authorize, denyResponse } from "@/lib/auth/guard";
import { findChatConn } from "@/lib/chat-bridge";
import { checkChatParams, isValidCursor } from "@/lib/chat-route";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

/** Eski sahifa so'rovi: javob 202; elementlar o'sha `cid` li SSE oqimiga `older:true` bilan keladi. */
export async function GET(request: Request, ctx: { params: Promise<{ sessionId: string }> }) {
  const auth = authorize(request, { touch: false });
  if (!auth.ok) return denyResponse(auth);
  const { sessionId } = await ctx.params;
  const sp = new URL(request.url).searchParams;
  const check = checkChatParams(sessionId, sp.get("cid"));
  if (!check.ok) return Response.json({ error: check.error }, { status: check.status, headers: NO_STORE });
  const before = sp.get("before");
  if (!isValidCursor(before)) return Response.json({ error: "invalid_cursor" }, { status: 400, headers: NO_STORE });
  const handle = findChatConn(check.cid, check.sessionId);
  if (!handle) return Response.json({ error: "stream_not_open" }, { status: 404, headers: NO_STORE });
  if (!handle.older(before)) return Response.json({ error: "not_ready" }, { status: 503, headers: NO_STORE });
  return Response.json({ ok: true }, { status: 202, headers: NO_STORE });
}
