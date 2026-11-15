import { authorize, denyResponse } from "@/lib/auth/guard";
import { openChatBridge, registerChatConn, unregisterChatConn } from "@/lib/chat-bridge";
import type { ChatBridgeEvent } from "@/lib/chat-bridge";
import { checkChatParams } from "@/lib/chat-route";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * SSE: bitta sessiya chati. Token serverda qoladi; har SSE ulanishi o'z center ulanishini ochadi va
 * uzilganda `chat.close` yuboradi. `event: chat` -> {kind:"items"|"state"|"bridge", ...}.
 * Eski sahifalar: `GET /api/chat/[sessionId]/older?cid=...&before=...` (natija shu oqimga keladi).
 */
export async function GET(request: Request, ctx: { params: Promise<{ sessionId: string }> }) {
  const auth = authorize(request, { touch: false });
  if (!auth.ok) return denyResponse(auth);
  const { sessionId } = await ctx.params;
  const check = checkChatParams(sessionId, new URL(request.url).searchParams.get("cid"));
  if (!check.ok) return Response.json({ error: check.error }, { status: check.status, headers: NO_STORE });

  const enc = new TextEncoder();
  let handle: ReturnType<typeof openChatBridge> | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  const shutdown = () => {
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = null;
    unregisterChatConn(check.cid);
    handle?.close();
    handle = null;
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (e: ChatBridgeEvent) => {
        try {
          controller.enqueue(enc.encode(`event: chat\ndata: ${JSON.stringify(e)}\n\n`));
        } catch {
          shutdown();
        }
      };
      controller.enqueue(enc.encode("retry: 3000\n\n"));
      handle = openChatBridge(check.sessionId, send);
      registerChatConn(check.cid, check.sessionId, handle);
      heartbeat = setInterval(() => {
        // H-01: sessiya tugasa chat oqimi ham yopiladi (center ulanishi bilan birga).
        if (!authorize(request, { touch: false }).ok) {
          shutdown();
          try {
            controller.close();
          } catch {
            // allaqachon yopilgan
          }
          return;
        }
        try {
          controller.enqueue(enc.encode(": hb\n\n"));
        } catch {
          shutdown();
        }
      }, 15_000);
      request.signal.addEventListener("abort", () => {
        shutdown();
        try {
          controller.close();
        } catch {
          // allaqachon yopilgan
        }
      });
    },
    cancel: shutdown,
  });

  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" },
  });
}
