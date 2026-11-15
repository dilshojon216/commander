import "server-only";
import {
  CLIENT_CHANNELS,
  CLIENT_WS_CLOSE,
  CLIENT_WS_PATH,
  ServerToClientMessageSchema,
  buildClientSubprotocols,
  createEnvelope,
} from "@commander/contracts";
import { getConfig } from "./config";
import type { BridgeEvent } from "./live-types";

/**
 * Server tomondagi WS ko'prik: BITTA /ws/client ulanishi (read token), undan kelgan push'lar
 * barcha SSE obunachilarga tarqatiladi. Token brauzerga chiqmaydi.
 * Obunachi qolmasa ulanish 10 s dan keyin yopiladi; xatoda eksponensial backoff (1..30 s).
 */

type Listener = (e: BridgeEvent) => void;

interface BridgeState {
  listeners: Set<Listener>;
  ws: WebSocket | null;
  ready: boolean;
  lockdown: { enabled: boolean; since: string | null } | null;
  error: string | null;
  backoffMs: number;
  retryTimer: ReturnType<typeof setTimeout> | null;
  pingTimer: ReturnType<typeof setInterval> | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

const g = globalThis as unknown as { __dashBridge?: BridgeState };
const state: BridgeState = (g.__dashBridge ??= {
  listeners: new Set(),
  ws: null,
  ready: false,
  lockdown: null,
  error: null,
  backoffMs: 1000,
  retryTimer: null,
  pingTimer: null,
  idleTimer: null,
});

function emit(e: BridgeEvent): void {
  for (const l of state.listeners) {
    try {
      l(e);
    } catch {
      // bitta obunachi xatosi boshqalarga ta'sir qilmasin
    }
  }
}

function statusEvent(): BridgeEvent {
  return { kind: "bridge", ready: state.ready, lockdown: state.lockdown, error: state.error };
}

function wsUrl(): string {
  const base = getConfig().apiUrl.replace(/^http/, "ws");
  return `${base}${CLIENT_WS_PATH}`;
}

function cleanup(): void {
  if (state.pingTimer) clearInterval(state.pingTimer);
  state.pingTimer = null;
  state.ws = null;
  state.ready = false;
}

function scheduleRetry(): void {
  if (state.retryTimer || state.listeners.size === 0) return;
  const delay = state.backoffMs;
  state.backoffMs = Math.min(state.backoffMs * 2, 30_000);
  state.retryTimer = setTimeout(() => {
    state.retryTimer = null;
    connect();
  }, delay);
}

function connect(): void {
  if (state.ws || state.listeners.size === 0) return;
  const token = getConfig().apiToken;
  if (!token) {
    state.error = "COMMANDER_API_TOKEN sozlanmagan";
    emit(statusEvent());
    return;
  }
  let ws: WebSocket;
  try {
    ws = new WebSocket(wsUrl(), buildClientSubprotocols(token));
  } catch {
    state.error = "Ulanib bo'lmadi";
    emit(statusEvent());
    scheduleRetry();
    return;
  }
  state.ws = ws;

  ws.onmessage = (ev: MessageEvent) => {
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
        state.lockdown = msg.payload.lockdown;
        ws.send(JSON.stringify(createEnvelope("subscribe", { channels: [...CLIENT_CHANNELS] })));
        return;
      case "subscribed":
        // Obuna tasdiqlandi: endi brauzer REST snapshot olishi mumkin (avval subscribe, keyin snapshot).
        state.ready = true;
        state.error = null;
        state.backoffMs = 1000;
        emit(statusEvent());
        return;
      case "auth.error":
        state.error = msg.payload.code === "insufficient_scope" ? "Token scope yetarli emas" : "Token rad etildi";
        emit(statusEvent());
        return;
      case "lockdown.updated":
        state.lockdown = msg.payload;
        emit(statusEvent());
        return;
      case "pong":
      case "error":
        return;
      default:
        emit({ kind: "push", type: msg.type, payload: msg.payload });
    }
  };
  ws.onclose = (ev: CloseEvent) => {
    cleanup();
    if (ev.code === CLIENT_WS_CLOSE.revoked) state.error = "Token bekor qilingan yoki muddati o'tgan";
    else if (!state.error) state.error = "Center bilan aloqa uzildi";
    emit(statusEvent());
    if (ev.code !== CLIENT_WS_CLOSE.authFailed && ev.code !== CLIENT_WS_CLOSE.revoked) scheduleRetry();
    else if (state.listeners.size > 0) {
      state.backoffMs = 30_000;
      scheduleRetry();
    }
  };
  ws.onerror = () => {
    // onclose ergashadi
  };
  state.pingTimer = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(createEnvelope("ping", {})));
  }, 25_000);
}

function disconnect(): void {
  if (state.retryTimer) clearTimeout(state.retryTimer);
  state.retryTimer = null;
  const ws = state.ws;
  if (ws) {
    ws.onclose = null;
    ws.close(1000);
  }
  cleanup();
}

/** Obuna bo'lish: darhol joriy holat yuboriladi; qaytgan funksiya obunani bekor qiladi. */
export function subscribeBridge(listener: Listener): () => void {
  if (state.idleTimer) clearTimeout(state.idleTimer);
  state.idleTimer = null;
  state.listeners.add(listener);
  listener(statusEvent());
  connect();
  return () => {
    state.listeners.delete(listener);
    if (state.listeners.size === 0 && !state.idleTimer) {
      state.idleTimer = setTimeout(() => {
        state.idleTimer = null;
        if (state.listeners.size === 0) disconnect();
      }, 10_000);
    }
  };
}
