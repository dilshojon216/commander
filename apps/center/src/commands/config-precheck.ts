import type { AgentControlState, ConfigCommandType } from '@commander/contracts';
import type { CommandRejection } from './control-logic.js';

/** Sozlamalar sinxronlash (3.7) oldindan tekshiruvi (sof). Oxirgi so'z agentdniki: u o'z `policy.json`ini qayta tekshiradi. */
export function precheckConfig(type: ConfigCommandType, c: AgentControlState, dryRun: boolean): CommandRejection | null {
  if (c.configSync !== true) return { code: 'agent_outdated', message: 'agentd does not support config sync yet (update agentd)' };
  const writes = type === 'config.rollback' || (type === 'config.apply' && !dryRun);
  const ok = writes ? c.allowConfigWrite === true : c.allowConfigRead === true || c.allowConfigWrite === true;
  if (ok) return null;
  return {
    code: 'config_not_allowed',
    message: writes ? 'Config writes are disabled in the machine\'s local policy (agentd policy allow-config)' : 'Config reads are disabled in the machine\'s local policy (agentd policy allow-config-read)',
  };
}

/** Haqiqiy qo'llash va qaytarish Telegram step-up talab qiladi (istisno qurilmalar o'tadi); capture va dry-run yo'q. */
export function configNeedsStepUp(type: ConfigCommandType, dryRun: boolean): boolean {
  return type === 'config.rollback' || (type === 'config.apply' && !dryRun);
}
