import { mkdirSync } from 'node:fs';
import { runClaude } from './claude-exec.js';
import { errMsg, type Logger } from './logger.js';

/**
 * Xavfsiz bir martalik `claude -p --model haiku` (project.summarize bilan bir xil bayroqlar): vositasiz (`--tools ""`),
 * faqat lokal sozlamalar, sessiya saqlanmaydi, slash-buyruqlarsiz, BO'SH papkada (loyiha kodi/CLAUDE.md'ga tegmaydi),
 * telemetriya o'chiq. Prompt argument sifatida beriladi; hech narsa diskka/logga yozilmaydi.
 */
export interface HaikuRun {
  claudeBin: string;
  /** Bo'sh papka (`~/.commander/summarize`). */
  dir: string;
  system: string;
  prompt: string;
  timeoutMs: number;
  log: Logger;
  label: string;
  /** Testlar uchun. */
  exec?: (args: string[], opts: { cwd: string; timeoutMs: number }) => Promise<string>;
}

export type HaikuOutcome =
  | { ok: true; text: string; model: string; tokens: number }
  | { ok: false; code: 'shim_unsupported' | 'failed' | 'error_result' };

interface Parsed {
  text: string;
  isError: boolean;
  model: string | null;
  tokens: number;
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);

/** `claude -p --output-format json`: bitta obyekt yoki hodisalar massivi; oxirgi `result` elementi (+ usage) kerak. */
export function parseClaudeResult(stdout: string): Parsed | null {
  let v: unknown;
  try {
    v = JSON.parse(stdout);
  } catch {
    return null;
  }
  const items: unknown[] = Array.isArray(v) ? v : [v];
  let model: string | null = null;
  let result: Parsed | null = null;
  for (const it of items) {
    if (typeof it !== 'object' || it === null) continue;
    const o = it as Record<string, unknown>;
    if (o['type'] === 'system' && typeof o['model'] === 'string') model = o['model'];
    if (o['type'] === 'result') {
      const u = typeof o['usage'] === 'object' && o['usage'] !== null ? (o['usage'] as Record<string, unknown>) : {};
      result = {
        text: typeof o['result'] === 'string' ? o['result'] : '',
        isError: o['is_error'] === true,
        model,
        tokens: num(u['input_tokens']) + num(u['output_tokens']) + num(u['cache_creation_input_tokens']),
      };
    }
  }
  return result ? { ...result, model: result.model ?? model } : null;
}

/** Haiku argumentlari (testlar bayroqlarni tekshiradi: vositasiz, sessiyasiz, faqat lokal sozlama). */
export function haikuArgs(system: string, prompt: string): string[] {
  return ['-p', '--model', 'haiku', '--tools', '', '--setting-sources', 'local', '--no-session-persistence', '--disable-slash-commands', '--output-format', 'json', '--system-prompt', system, '--', prompt];
}

export async function runHaiku(r: HaikuRun): Promise<HaikuOutcome> {
  const args = haikuArgs(r.system, r.prompt);
  let stdout: string;
  try {
    mkdirSync(r.dir, { recursive: true, mode: 0o700 });
    stdout = r.exec
      ? await r.exec(args, { cwd: r.dir, timeoutMs: r.timeoutMs })
      : await runClaude(r.claudeBin, args, { timeout: r.timeoutMs, maxBuffer: 8 * 1024 * 1024, cwd: r.dir, env: { CLAUDE_CODE_ENABLE_TELEMETRY: '0', OTEL_SDK_DISABLED: 'true' } });
  } catch (err) {
    const msg = errMsg(err);
    r.log.warn(`${r.label}: claude ishlamadi`, { error: msg.slice(0, 200) });
    return { ok: false, code: /sobit literal|xavfli belgilar/.test(msg) ? 'shim_unsupported' : 'failed' };
  }
  const parsed = parseClaudeResult(stdout);
  if (!parsed) return { ok: false, code: 'failed' };
  if (parsed.isError) return { ok: false, code: 'error_result' };
  return { ok: true, text: parsed.text, model: parsed.model ?? 'haiku', tokens: parsed.tokens };
}
