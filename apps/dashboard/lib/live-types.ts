/** Server (bridge) -> brauzer (SSE) xabar turlari. Token yo'q. */
export interface LockdownState {
  enabled: boolean;
  since: string | null;
}

export type BridgeEvent =
  | { kind: "bridge"; ready: boolean; lockdown: LockdownState | null; error: string | null }
  | { kind: "push"; type: string; payload: unknown };
