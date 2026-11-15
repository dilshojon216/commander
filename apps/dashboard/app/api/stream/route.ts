import { authorize, denyResponse } from "@/lib/auth/guard";
import { subscribeBridge } from "@/lib/bridge";
import type { BridgeEvent } from "@/lib/live-types";

export const dynamic = "force-dynamic";

/**
 * SSE: brauzerga center push'larini uzatadi (token serverda qoladi).
 * `event: bridge` (holat) va `event: push` ({type,payload}).
 */
export async function GET(request: Request) {
  const auth = authorize(request, { touch: false });
  if (!auth.ok) return denyResponse(auth);
  const enc = new TextEncoder();
  let unsubscribe: (() => void) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const close = () => {
        if (heartbeat) clearInterval(heartbeat);
        unsubscribe?.();
        unsubscribe = null;
        try {
          controller.close();
        } catch {
          // allaqachon yopilgan
        }
      };
      const send = (e: BridgeEvent) => {
        const data = e.kind === "bridge" ? e : { type: e.type, payload: e.payload };
        try {
          controller.enqueue(enc.encode(`event: ${e.kind}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          close();
        }
      };
      controller.enqueue(enc.encode("retry: 3000\n\n"));
      unsubscribe = subscribeBridge(send);
      heartbeat = setInterval(() => {
        // H-01: sessiya tugasa (idle/mutlaq muddat/chiqish) oqim ham yopiladi: ochiq SSE sessiyadan uzoq yashamaydi.
        if (!authorize(request, { touch: false }).ok) {
          close();
          return;
        }
        try {
          controller.enqueue(enc.encode(": hb\n\n"));
        } catch {
          close();
        }
      }, 15_000);
      request.signal.addEventListener("abort", close);
    },
    cancel() {
      if (heartbeat) clearInterval(heartbeat);
      unsubscribe?.();
      unsubscribe = null;
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
