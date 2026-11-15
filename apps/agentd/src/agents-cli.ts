import { z } from 'zod';
import type { ActiveSession } from '@commander/contracts';
import { runClaude } from './claude-exec.js';

/**
 * `claude agents --json` (spike S8): interaktiv va fon sessiyalarni ko'rsatadi:
 * `sessionId`, `pid?`, `cwd`, `kind` (`interactive` | `background`), `status`/`state`, `name`.
 */
const AgentEntrySchema = z.looseObject({
  sessionId: z.string().min(1).max(255),
  cwd: z.string().min(1).max(4096).optional(),
  kind: z.string().optional(),
  pid: z.number().int().positive().optional(),
});
const AgentsOutputSchema = z.array(AgentEntrySchema);

export interface LiveSession {
  claudeSessionId: string;
  cwd?: string;
  kind?: ActiveSession['kind'];
  /** Interaktiv sessiyada tmux pane'ni topish uchun (markazga yuborilmaydi). */
  pid?: number;
}

export function parseAgentsJson(stdout: string): LiveSession[] {
  const parsed = AgentsOutputSchema.parse(JSON.parse(stdout));
  return parsed.map((e) => ({
    claudeSessionId: e.sessionId,
    ...(e.cwd ? { cwd: e.cwd } : {}),
    ...(e.pid ? { pid: e.pid } : {}),
    ...(e.kind === 'interactive' ? { kind: 'interactive' as const } : e.kind === 'background' || e.kind === 'bg' ? { kind: 'bg' as const } : {}),
  }));
}

export type AgentsLister = () => Promise<LiveSession[]>;

/** `claude agents --json` ni ishga tushiradi. Xato/timeout -> tashlaydi (chaqiruvchi toleran bo'ladi). */
export function createAgentsLister(claudeBin: string, timeoutMs = 10_000): AgentsLister {
  return async () => parseAgentsJson(await runClaude(claudeBin, ['agents', '--json'], { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }));
}
