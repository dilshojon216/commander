import { z } from 'zod';
import { runClaude } from './claude-exec.js';

/**
 * `claude agents --json [--all]` ning to'liq ko'rinishi (spike 2026-11-13, CC 2.1.304): har yozuvda `sessionId`, `kind`
 * (`interactive` | `background`), `cwd`, `startedAt` (ms), `name`; fon sessiyalarda `id` (8 belgi, `claude stop|attach` FAQAT shuni
 * qabul qiladi, to'liq sessionId emas), `state` (`done` | `blocked` ...); ishlayotgan jarayonda `pid` va `status` (`idle` | `busy` | `waiting`).
 * `stop`dan keyin `pid` yo'qoladi (jarayon tugadi), yozuv `--all` da qoladi.
 */
const EntrySchema = z.looseObject({
  sessionId: z.string().min(1).max(255),
  id: z.string().regex(/^[0-9a-f]{8}$/).optional(),
  pid: z.number().int().positive().optional(),
  cwd: z.string().min(1).max(4096).optional(),
  kind: z.string().optional(),
  status: z.string().optional(),
  state: z.string().optional(),
  startedAt: z.number().optional(),
  name: z.string().optional(),
});

export interface AgentEntry {
  claudeSessionId: string;
  /** Qisqa id (faqat fon sessiyalarda). */
  shortId?: string;
  pid?: number;
  cwd?: string;
  kind: 'interactive' | 'bg' | 'unknown';
  status?: string;
  state?: string;
  startedAt?: number;
}

export function parseAgentEntries(stdout: string): AgentEntry[] {
  return z.array(EntrySchema).parse(JSON.parse(stdout)).map((e) => ({
    claudeSessionId: e.sessionId,
    ...(e.id ? { shortId: e.id } : {}),
    ...(e.pid ? { pid: e.pid } : {}),
    ...(e.cwd ? { cwd: e.cwd } : {}),
    kind: e.kind === 'interactive' ? ('interactive' as const) : e.kind === 'background' || e.kind === 'bg' ? ('bg' as const) : ('unknown' as const),
    ...(e.status ? { status: e.status } : {}),
    ...(e.state ? { state: e.state } : {}),
    ...(e.startedAt !== undefined ? { startedAt: e.startedAt } : {}),
  }));
}

export type AgentEntriesLister = () => Promise<AgentEntry[]>;

export function createAgentEntriesLister(claudeBin: string, timeoutMs = 10_000): AgentEntriesLister {
  return async () => parseAgentEntries(await runClaude(claudeBin, ['agents', '--all', '--json'], { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }));
}
