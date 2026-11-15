import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ConfigService } from '@nestjs/config';
import type { CommandType } from '@commander/contracts';

export const COMMANDS_OPTIONS = Symbol('COMMANDS_OPTIONS');

export interface CommandsOptions {
  /** Muddati o'tgan buyruqlarni tekshirish oralig'i (ms). */
  sweepMs: number;
  /** Markaz imzo kaliti fayli (0600). `null` = xotirada (testlar). `signer` sozlangan bo'lsa HECH QACHON o'qilmaydi/yaratilmaydi. */
  keyFile: string | null;
  /**
   * Host imzolovchi (5.7, H-02): `tcp://host:port` yoki soket yo'li (`SIGNER_SOCKET`). Sozlangan bo'lsa kalit Keychain'da,
   * markaz faqat imzo so'raydi va fayl-kalitga FALLBACK YO'Q (imzolovchi yetib bo'lmasa buyruqlar fail-closed).
   */
  signer: { endpoint: string; authFile: string } | null;
  /** `SIGNER_REQUIRED=1`: imzolovchi sozlanmagan bo'lsa markaz ISHGA TUSHMAYDI (production: fayl-kalitga qaytish taqiqlangan). */
  signerRequired: boolean;
  /** Qurilma bo'yicha limitlar: `[limit, oyna ms]`. */
  rateLimits: Record<CommandType, readonly [number, number]>;
}

export const DEFAULT_COMMANDS_OPTIONS: Omit<CommandsOptions, 'keyFile' | 'signer' | 'signerRequired'> = {
  sweepMs: 2_000,
  rateLimits: {
    'session.start': [6, 10 * 60_000],
    'session.prompt': [30, 60_000],
    'session.stop': [30, 60_000],
    'session.set_mode': [10, 60_000],
    'session.remote_control': [10, 60_000],
    'session.resume': [6, 10 * 60_000],
    'session.close': [20, 10 * 60_000],
    'project.refresh': [30, 60_000],
    'project.read_md': [30, 60_000],
    'project.append_tasks': [20, 60_000],
    'project.summarize': [10, 10 * 60_000],
    'assistant.ask': [20, 10 * 60_000],
    'config.capture': [10, 10 * 60_000],
    'config.apply': [40, 10 * 60_000],
    'config.rollback': [10, 10 * 60_000],
    'project.diff': [60, 60_000],
    'project.open_pr': [10, 10 * 60_000],
    'project.ci_status': [60, 60_000],
    'logs.tail': [60, 60_000],
    'deploy.inspect': [30, 60_000],
    'deploy.run': [10, 10 * 60_000],
    'deploy.rollback': [10, 10 * 60_000],
    'git.checkpoint': [30, 10 * 60_000],
    'git.checkpoint_list': [60, 60_000],
    'git.checkpoint_restore': [10, 10 * 60_000],
    'project.scan': [60, 10 * 60_000],
  },
};

export function commandsOptionsFromConfig(config: ConfigService): CommandsOptions {
  // Testlar (vitest) haqiqiy home'ga kalit yozmasin: xotirada.
  if (process.env['VITEST']) return { ...DEFAULT_COMMANDS_OPTIONS, keyFile: null, signer: null, signerRequired: false };
  const configured = (config.get<string>('CENTER_KEY_FILE') ?? '').trim();
  const endpoint = (config.get<string>('SIGNER_SOCKET') ?? '').trim();
  const authFile = (config.get<string>('SIGNER_AUTH_FILE') ?? '').trim() || '/run/commander-signer/auth.secret';
  const required = ['1', 'true'].includes((config.get<string>('SIGNER_REQUIRED') ?? '').trim().toLowerCase());
  return {
    ...DEFAULT_COMMANDS_OPTIONS,
    keyFile: configured || join(homedir(), '.commander-center', 'command-signing.key'),
    signer: endpoint ? { endpoint, authFile } : null,
    signerRequired: required,
  };
}
