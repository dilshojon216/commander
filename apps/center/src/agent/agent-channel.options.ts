import {
  AGENT_AUTH_TIMEOUT_MS,
  AGENT_HEARTBEAT_INTERVAL_MS,
  AGENT_HEARTBEAT_TIMEOUT_MS,
  AGENT_LIMITS,
} from '@commander/contracts';

/** Kanal sozlamalari (testlarda qisqa muddatlar bilan almashtiriladi). Default'lar kontraktdan. */
export interface AgentChannelOptions {
  authTimeoutMs: number;
  heartbeatIntervalMs: number;
  heartbeatTimeoutMs: number;
  maxMessagesPerMinute: number;
  /** Autentifikatsiyadan o'tmagan bir vaqtdagi ulanishlar chegarasi (handshake to'fonidan himoya). */
  maxPendingAuth: number;
  /** Qurilma bekor qilinganini qayta tekshirish oralig'i. */
  revokeCheckIntervalMs: number;
}

export const AGENT_CHANNEL_OPTIONS = Symbol('AGENT_CHANNEL_OPTIONS');

export const DEFAULT_AGENT_CHANNEL_OPTIONS: AgentChannelOptions = {
  authTimeoutMs: AGENT_AUTH_TIMEOUT_MS,
  heartbeatIntervalMs: AGENT_HEARTBEAT_INTERVAL_MS,
  heartbeatTimeoutMs: AGENT_HEARTBEAT_TIMEOUT_MS,
  maxMessagesPerMinute: AGENT_LIMITS.maxMessagesPerMinute,
  maxPendingAuth: 20,
  revokeCheckIntervalMs: 15_000,
};
