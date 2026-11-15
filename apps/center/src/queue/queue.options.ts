import { dirname, join } from 'node:path';
import type { ConfigService } from '@nestjs/config';
import type { CommandsOptions } from '../commands/commands.options.js';

export const QUEUE_OPTIONS = Symbol('QUEUE_OPTIONS');

export interface QueueOptions {
  /** Scheduler tiki (ms). */
  tickMs: number;
  /** Prompt shifrlash kaliti fayli (0600). `null` = xotirada (testlar). */
  keyFile: string | null;
  /** Bir vaqtda `starting` elementlar (markaz bo'yicha). */
  maxStartingNow: number;
  /** Sozlama `queue.block_when_limit_exhausted` (settings, jsonb boolean) bo'lmasa shu default. */
  blockWhenExhausted: boolean;
}

export function queueOptionsFromConfig(_config: ConfigService, commands: CommandsOptions): QueueOptions {
  // Kalit secrets volume'da (qo'shimcha env shart emas): `<CENTER_KEY_FILE dir>/queue-prompt.key`. 5.7: imzo kaliti imzolovchiga ko'chdi,
  // `CENTER_KEY_FILE` endi faqat shu katalogni belgilaydi; queue-prompt.key ATAYLAB markazda qoldi (PLAN ADR "host imzolovchi").
  const keyFile = process.env['VITEST'] || commands.keyFile === null ? null : join(dirname(commands.keyFile), 'queue-prompt.key');
  return { tickMs: 30_000, keyFile, maxStartingNow: 2, blockWhenExhausted: true };
}
