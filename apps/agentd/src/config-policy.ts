import type { CommandErrorCode, ConfigCommandType } from '@commander/contracts';

/**
 * Sozlamalar sinxronlash siyosati (3.7). DEFAULT = O'CHIQ (ikkalasi `false`): egasi mashinada `agentd policy allow-config`
 * (yozish + o'qish) yoki `allow-config-read` (faqat o'qish: capture va dry-run) bilan yoqadi. Markazdan o'zgartirilmaydi.
 *  - `config.capture` va `config.apply {dryRun:true}`: `allowConfigRead` (yoki `allowConfigWrite`);
 *  - `config.apply` (haqiqiy) va `config.rollback`: `allowConfigWrite`.
 */
export type ConfigPolicyDecision = { ok: true } | { ok: false; code: CommandErrorCode; message: string };

export function decideConfigPolicy(type: ConfigCommandType, r: { allowConfigRead: boolean; allowConfigWrite: boolean }, dryRun: boolean): ConfigPolicyDecision {
  const writes = type === 'config.rollback' || (type === 'config.apply' && !dryRun);
  const allowed = writes ? r.allowConfigWrite : r.allowConfigRead || r.allowConfigWrite;
  if (allowed) return { ok: true };
  return {
    ok: false,
    code: 'config_not_allowed',
    message: writes ? 'Config writes are disabled in the local policy (run `agentd policy allow-config`)' : 'Config reads are disabled in the local policy (run `agentd policy allow-config-read`)',
  };
}
