import "server-only";
import {
  CLIENT_WS_CLOSE,
  CLIENT_WS_PATH,
  ServerToClientMessageSchema,
  buildClientSubprotocols,
  createEnvelope,
} from "@commander/contracts";
import type { ChatItemsToClientPayload, ChatState, ChatErrorCode } from "@commander/contracts";
import { getConfig } from "./config";

/**
 * Bitta sessiya chati uchun server tomondagi WS ko'prik. Har brauzer SSE ulanishi o'z /ws/client ulanishini
 * ochadi (read token faqat shu yerda): center ref-count'i ulanish bo'yicha yuritadi, shu sabab brauzer
 * uzilganda `chat.close` (va ulanish yopilishi) oqimni to'g'ri to'xtatadi. Faqat shu sessiyaning
 * `chat.items` / `chat.state` xabarlari uzatiladi. Chat matni hech qaerda log qilinmaydi.
 */

export type ChatBridgeEvent =
  | { kind: "items"; payload: ChatItemsToClientPayload }
  | { kind: "state"; state: ChatState; code?: ChatErrorCode }
  | { kind: "bridge"; error: string | null };

export interface ChatBridgeHandle {
  /** Eski sahifa so'rash (`chat.open {before}`); natija `items {older:true}` bilan SSE'ga keladi. */
  older(before: string): boolean;
  close(): void;
}

const OLDER_PAGE = 100;

const g = globalThis as unknown as { __chatConns?: Map<string, { sessionId: string; handle: ChatBridgeHandle }> };
const registry = (g.__chatConns ??= new Map());

export function registerChatConn(cid: string, sessionId: string, handle: ChatBridgeHandle): void {
  registry.set(cid, { sessionId, handle });
}
export function unregisterChatConn(cid: string): void {
  registry.delete(cid);
}
export function findChatConn(cid: string, sessionId: string): ChatBridgeHandle | null {
  const e = registry.get(cid);
  return e && e.sessionId === sessionId ? e.handle : null;
}

export function openChatBridge(sessionId: string, onEvent: (e: ChatBridgeEvent) => void): ChatBridgeHandle {
  let ws: WebSocket | null = null;
  let authed = false;
  let closed = false;
  let backoff = 1000;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let ping: ReturnType<typeof setInterval> | null = null;

  const url = () => `${getConfig().apiUrl.replace(/^http/, "ws")}${CLIENT_WS_PATH}`;
  const send = (type: "chat.open" | "chat.close", payload: object) => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(createEnvelope(type, payload)));
  };

  const schedule = () => {
    if (closed || retry) return;
    const d = backoff;
    backoff = Math.min(backoff * 2, 30_000);
    retry = setTimeout(() => {
      retry = null;
      connect();
    }, d);
  };

  function connect(): void {
    if (closed) return;
    const token = getConfig().apiToken;
    if (!token) {
      onEvent({ kind: "bridge", error: "COMMANDER_API_TOKEN sozlanmagan" });
      return;
    }
    let sock: WebSocket;
    try {
      sock = new WebSocket(url(), buildClientSubprotocols(token));
    } catch {
      onEvent({ kind: "bridge", error: "Ulanib bo'lmadi" });
      schedule();
      return;
    }
    ws = sock;
    authed = false;
    sock.onmessage = (ev: MessageEvent) => {
      if (typeof ev.data !== "string") return;
      let raw: unknown;
      try {
        raw = JSON.parse(ev.data);
      } catch {
        return;
      }
      const parsed = ServerToClientMessageSchema.safeParse(raw);
      if (!parsed.success) return;
      const msg = parsed.data;
      switch (msg.type) {
        case "auth.ok":
          authed = true;
          backoff = 1000;
          onEvent({ kind: "bridge", error: null });
          send("chat.open", { sessionId });
          return;
        case "auth.error":
          onEvent({ kind: "bridge", error: msg.payload.code === "insufficient_scope" ? "Token scope yetarli emas" : "Token rad etildi" });
          return;
        case "chat.items":
          if (msg.payload.sessionId === sessionId) onEvent({ kind: "items", payload: msg.payload });
          return;
        case "chat.state":
          if (msg.payload.sessionId === sessionId) onEvent({ kind: "state", state: msg.payload.state, code: msg.payload.code });
          return;
        default:
          return;
      }
    };
    sock.onclose = (ev: CloseEvent) => {
      if (ping) clearInterval(ping);
      ping = null;
      ws = null;
      authed = false;
      if (closed) return;
      onEvent({ kind: "bridge", error: "Center bilan aloqa uzildi" });
      if (ev.code === CLIENT_WS_CLOSE.authFailed || ev.code === CLIENT_WS_CLOSE.revoked) backoff = 30_000;
      schedule();
    };
    sock.onerror = () => {
      // onclose ergashadi
    };
    ping = setInterval(() => {
      if (sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify(createEnvelope("ping", {})));
    }, 25_000);
  }

  connect();

  return {
    older(before: string): boolean {
      if (!authed) return false;
      send("chat.open", { sessionId, before, limit: OLDER_PAGE });
      return true;
    },
    close(): void {
      if (closed) return;
      closed = true;
      if (retry) clearTimeout(retry);
      if (ping) clearInterval(ping);
      const sock = ws;
      if (sock) {
        sock.onclose = null;
        send("chat.close", { sessionId });
        sock.close(1000);
      }
      ws = null;
    },
  };
}
