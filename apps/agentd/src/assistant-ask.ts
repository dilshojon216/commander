import { ASK_SYSTEM_PROMPT, AskPayloadSchema, buildAskPrompt, parseAskOutput } from '@commander/contracts';
import type { AskPayload } from '@commander/contracts';
import { runHaiku } from './haiku-oneshot.js';
import type { Logger } from './logger.js';
import { redactChatText } from './redact.js';
import type { RunnerOutcome } from './runner.js';

export interface AssistantAskDeps {
  claudeBin: string;
  /** Bo'sh papka (`~/.commander/summarize`). */
  dir: string;
  log: Logger;
  timeoutMs?: number;
  exec?: (args: string[], opts: { cwd: string; timeoutMs: number }) => Promise<string>;
}

const fail = (code: NonNullable<RunnerOutcome['code']>, message: string): RunnerOutcome => ({ ok: false, code, message });

/**
 * `assistant.ask` (6.2): markaz tuzgan TUZILGAN kontekst + savol -> haiku (vositasiz, bo'sh papka, sessiyasiz) -> javob.
 * Faqat o'qish: hech qanday fayl/vosita yo'q. Javob redakt qilinadi va `result.assistant` ichida qaytadi (markaz DB'ga yozmaydi).
 * Payload agentd'da qayta tekshiriladi (imzo `CommandManager`da tekshirilgan, sxema bu yerda).
 */
export class AssistantOps {
  constructor(private readonly d: AssistantAskDeps) {}

  async ask(raw: AskPayload): Promise<RunnerOutcome> {
    const p = AskPayloadSchema.safeParse(raw);
    if (!p.success) return fail('invalid_payload', 'assistant.ask payload is invalid');
    const out = await runHaiku({
      claudeBin: this.d.claudeBin,
      dir: this.d.dir,
      system: ASK_SYSTEM_PROMPT,
      prompt: buildAskPrompt(p.data),
      timeoutMs: this.d.timeoutMs ?? 100_000,
      log: this.d.log,
      label: 'assistant.ask',
      ...(this.d.exec ? { exec: this.d.exec } : {}),
    });
    if (!out.ok) return out.code === 'shim_unsupported' ? fail('shim_unsupported', 'claude.cmd shim cannot run assistant (native claude.exe is required)') : fail('ask_failed', 'claude -p did not complete');
    const parsed = parseAskOutput(out.text, out.model, redactChatText);
    if (!parsed) return fail('ask_failed', 'claude returned an empty answer');
    return { ok: true, result: { assistant: parsed } };
  }
}
