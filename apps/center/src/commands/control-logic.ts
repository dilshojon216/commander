import { STEP_UP_PERMISSION_MODES, isConfigCommandType, isGitCommandType, isLogsCommandType, isProjectCommandType } from '@commander/contracts';
import { precheckConfig } from './config-precheck.js';
import { isRepoCommandType, precheckRepoCommand } from './deploy-commands.js';
import type { AgentControlState, CommandErrorCode, CommandType, ControlReason, RemotePermissionMode, ResumeReason, SessionControls, SessionResume } from '@commander/contracts';

/**
 * Sof mantiq (DB'siz): sessiya "boshqariluvchanligi" va buyruq oldindan tekshiruvi. `SessionDto` ham, `CommandsService` ham
 * shuni ishlatadi, shu sabab UI ko'rsatadigan holat va markaz rad etadigan holat har doim mos.
 *
 * Markaz agentd siyosatini O'ZGARTIRMAYDI va bu yerdagi natija faqat "oldindan rad": oxirgi so'z agentdniki
 * (agentd o'z `policy.json`ini va imzoni qayta tekshiradi).
 */

/**
 * Boshqariladigan (bg) sessiyaning ruxsat rejimini o'zgartirish: Claude Code 2.1.304'da YO'Q (spike 2026-11-13):
 * `claude --bg --resume <id> --permission-mode X` saqlangan opsiyalarni o'zgartirmaydi, balki NUSXA (fork) ochadi.
 * Shu sabab `session.set_mode` hozir hamma sessiyada `set_mode_unsupported` bilan tugaydi; imkoniyat paydo bo'lsa shu bayroq yoqiladi.
 */
export const SET_MODE_SUPPORTED_FOR_BG = false;

export interface SessionControlInput {
  machineOnline: boolean;
  /** `machines.control` (agentd heartbeat), `null` = hech qachon e'lon qilinmagan. */
  control: AgentControlState | null;
  /** `sessions.kind`: `bg` boshqariladi; `tmux` = tmux ichidagi terminal sessiya (agentd pane'ni tekshirgan, 2.6): prompt + stop; `interactive` = faqat ko'rish. */
  sessionKind: string;
  ended: boolean;
  /** `machines.os` (`process.platform`): Windows'da SIGINT yo'q. */
  machineOs: string | null;
}

export interface SessionControlView {
  controllable: boolean;
  controlReason: ControlReason | null;
  controls: SessionControls;
}

const NONE: SessionControls = { prompt: false, stop: false, setMode: false };

/** Agent shu qadar tayyormi (siyosat yoqilgan, kalit pin qilingan, root emas). `null` = tayyor, aks holda sabab. */
export function agentNotReadyReason(control: AgentControlState | null): ControlReason | null {
  if (!control) return 'agent_outdated';
  if (!control.enabled) return 'policy_disabled';
  if (!control.centerKeyPinned || control.runningAsRoot) return 'agent_not_ready';
  return null;
}

/** 3.10: tmux sessiyada RC'ni yoqish/o'chirish: agentd e'lon qilgan va siyosat `allowPrompt` bergan bo'lsa (RC = claude.ai'dan boshqarish). */
export function canToggleRemoteControl(c: AgentControlState): boolean {
  return c.remoteControl === true && c.allowPrompt;
}

export function sessionControl(i: SessionControlInput): SessionControlView {
  if (i.ended) return { controllable: false, controlReason: 'session_ended', controls: NONE };
  if (!i.machineOnline) return { controllable: false, controlReason: 'machine_offline', controls: NONE };
  const notReady = agentNotReadyReason(i.control);
  if (notReady) return { controllable: false, controlReason: notReady, controls: NONE };
  const c = i.control as AgentControlState;

  if (i.sessionKind === 'bg') {
    const controls: SessionControls = { prompt: c.allowPrompt, stop: c.allowStop, setMode: c.allowSetMode && SET_MODE_SUPPORTED_FOR_BG };
    return { controllable: c.allowPrompt, controlReason: c.allowPrompt ? null : 'prompt_not_allowed', controls };
  }
  if (i.sessionKind === 'tmux' && i.machineOs !== 'win32') {
    // tmux: prompt = bracketed paste + Enter (faqat bo'sh sessiyaga), stop = Escape (turnni to'xtatish, chiqmaydi). set_mode yo'q.
    return { controllable: c.allowPrompt, controlReason: c.allowPrompt ? null : 'prompt_not_allowed', controls: { prompt: c.allowPrompt, stop: c.allowStop, setMode: false, ...(canToggleRemoteControl(c) ? { remoteControl: true } : {}), ...(c.close === true && c.allowStop ? { close: true } : {}) } };
  }
  // Terminal (interaktiv) sessiya: prompt yo'q ("faqat ko'rish"); to'xtatish = SIGINT (faqat POSIX, siyosat ruxsat bersa).
  const canInterrupt = c.allowStop && i.machineOs !== 'win32';
  return { controllable: false, controlReason: 'interactive', controls: { prompt: false, stop: canInterrupt, setMode: false } };
}

// --- 6.14: tugagan terminal sessiyani tmux'da davom ettirish ----------------------------------------------

export interface SessionResumeInput extends SessionControlInput {
  /** Sessiyaning saqlangan cwd'si (agentga markaz DB'sidan boradi); yo'q = davom ettirib bo'lmaydi. */
  cwd: string | null;
}

const RESUME_REASON_REJECTION: Record<ResumeReason, CommandRejection> = {
  not_ended: { code: 'session_still_running', message: 'Sessiya hali terminalda ochiq — avval undan chiqing' },
  not_terminal: { code: 'interactive_session', message: 'Only an ended terminal session can be resumed (background sessions continue with a prompt)' },
  machine_offline: { code: 'machine_offline', message: 'The machine is offline (agentd is not connected)' },
  policy_disabled: { code: 'policy_disabled', message: 'Remote control is disabled in the machine\'s local policy' },
  agent_not_ready: { code: 'policy_disabled', message: 'agentd is not ready for remote control (center key not pinned, or running as root)' },
  agent_outdated: { code: 'agent_outdated', message: 'agentd does not support resuming sessions yet (update agentd)' },
  start_not_allowed: { code: 'action_not_allowed', message: 'Starting sessions remotely is not allowed by the local policy' },
  unsupported_os: { code: 'resume_unsupported', message: 'Windows\'da tmux yo\'q: sessiyani davom ettirib bo\'lmaydi' },
  no_cwd: { code: 'cwd_invalid', message: 'The session has no saved working directory' },
};

/**
 * "Davom ettirish" mumkinmi: faqat TUGAGAN terminal (interaktiv/tmux) sessiya; mashina onlayn, agentd `resume` e'lon qilgan,
 * lokal siyosat `allowStart` bergan (resume = tmux ichida yangi sessiya ochish, `session.start` qoidalari) va Windows emas.
 * Fon (bg) sessiya bu yo'ldan emas: uni prompt davom ettiradi. Tartib muhim: eng ma'noli sabab birinchi.
 */
export function sessionResume(i: SessionResumeInput): SessionResume {
  const no = (reason: ResumeReason): SessionResume => ({ available: false, reason });
  if (i.sessionKind === 'bg') return no('not_terminal');
  if (!i.ended) return no('not_ended');
  if (i.machineOs === 'win32') return no('unsupported_os');
  if (!i.machineOnline) return no('machine_offline');
  const notReady = agentNotReadyReason(i.control);
  if (notReady === 'policy_disabled') return no('policy_disabled');
  if (notReady === 'agent_not_ready') return no('agent_not_ready');
  if (notReady) return no('agent_outdated');
  const c = i.control as AgentControlState;
  if (c.resume !== true) return no('agent_outdated');
  if (!c.allowStart) return no('start_not_allowed');
  if (!i.cwd) return no('no_cwd');
  return { available: true, reason: null };
}

/** `session.resume` oldindan rad etish: `sessionResume` sababi kodga aylanadi. `null` = davom etsin. */
export function precheckResume(i: SessionResumeInput): CommandRejection | null {
  const r = sessionResume(i);
  return r.available || r.reason === null ? null : RESUME_REASON_REJECTION[r.reason];
}

export interface CommandRejection {
  code: CommandErrorCode;
  message: string;
}

export interface PrecheckInput {
  type: CommandType;
  permissionMode?: RemotePermissionMode;
  machineOnline: boolean;
  control: AgentControlState | null;
  machineOs: string | null;
  /** Sessiya buyruqlari uchun. */
  session?: { kind: string; ended: boolean; cwd?: string | null } | null;
  /** `session.start` + `remoteControl: true` (3.10). */
  remoteControl?: boolean;
  /** `config.apply` dry-run (3.7): faqat o'qish ruxsati kerak. */
  configDryRun?: boolean;
}

const REASON_TO_REJECTION: Record<string, CommandRejection> = {
  agent_outdated: { code: 'agent_outdated', message: 'agentd has not announced remote-control support (update agentd)' },
  policy_disabled: { code: 'policy_disabled', message: 'Remote control is disabled in the machine\'s local policy' },
  agent_not_ready: { code: 'policy_disabled', message: 'agentd is not ready for remote control (center key not pinned, or running as root)' },
};

/** Markaz tomonida oldindan rad etish (`rejected` qator yoziladi). `null` = davom etsin. */
export function precheckCommand(i: PrecheckInput): CommandRejection | null {
  // 6.14: davom ettirish aynan TUGAGAN sessiyaga yo'naltirilgan: umumiy "session_ended" rad etishdan oldin
  if (i.type === 'session.resume') {
    if (!i.session) return { code: 'session_not_found', message: 'The session was not found' };
    return precheckResume({ machineOnline: i.machineOnline, control: i.control, sessionKind: i.session.kind, ended: i.session.ended, machineOs: i.machineOs, cwd: i.session.cwd ?? null });
  }
  if (i.session?.ended) return { code: 'session_ended', message: 'The session has ended' };
  if (!i.machineOnline) return { code: 'machine_offline', message: 'The machine is offline (agentd is not connected)' };
  const notReady = agentNotReadyReason(i.control);
  if (notReady) return REASON_TO_REJECTION[notReady] ?? { code: 'policy_disabled', message: 'Remote control is not available' };
  const c = i.control as AgentControlState;
  if (isConfigCommandType(i.type)) return precheckConfig(i.type, c, i.configDryRun === true);
  // Deploy (6.5) va checkpoint (6.9): agentd e'loni + siyosat bayrog'i (`deploy-commands.ts`)
  if (isRepoCommandType(i.type)) return precheckRepoCommand(i.type, c);
  if (isLogsCommandType(i.type)) {
    // Log ko'ruvchi (6.6): agentd `logs` e'lon qilgan bo'lishi va siyosat `allowLogs` bermasligi mumkin (fayl loglari uchun yana ildizlar kerak)
    if (c.logs !== true) return { code: 'agent_outdated', message: 'agentd does not support the log viewer yet (update agentd)' };
    if (c.allowLogs === false) return { code: 'action_not_allowed', message: 'Logs are disabled in the machine\'s local policy (agentd policy allow-logs)' };
    return null;
  }
  if (i.type === 'assistant.ask') {
    // 6.2: faqat o'qish (vositasiz haiku): agentd `assistant` e'lon qilgan va siyosat o'qishga ruxsat bergan bo'lishi shart
    if (c.assistant !== true) return { code: 'agent_outdated', message: 'agentd does not support the assistant yet (update agentd)' };
    if (c.allowProjectRead === false) return { code: 'action_not_allowed', message: 'assistant.ask is not allowed by the local policy' };
    return null;
  }

  if (isProjectCommandType(i.type)) {
    // Loyiha buyruqlari (2.15): agentd shularni biladi (`projectOps`), siyosat o'qish/yozishga ruxsat beradi.
    if (c.projectOps !== true) return { code: 'agent_outdated', message: 'agentd does not support project commands yet (update agentd)' };
    // Git/PR (3.5): agentd `gitOps` e'lon qilgan bo'lishi shart; PR ochish (push + gh) yozish ruxsatini talab qiladi
    if (isGitCommandType(i.type) && c.gitOps !== true) return { code: 'agent_outdated', message: 'agentd does not support git commands yet (update agentd)' };
    // Xavfsizlik tekshiruvi (6.10): agentd `scan` e'lon qilgan va siyosat `allowScan` bermasligi mumkin (default ruxsat: faqat o'qish)
    if (i.type === 'project.scan') {
      if (c.scan !== true) return { code: 'agent_outdated', message: 'agentd does not support project scans yet (update agentd)' };
      if (c.allowScan === false) return { code: 'action_not_allowed', message: 'Scans are disabled in the machine\'s local policy (agentd policy allow-scan)' };
    }
    const write = i.type === 'project.append_tasks' || i.type === 'project.open_pr';
    if (write ? c.allowProjectWrite === false : c.allowProjectRead === false) {
      return { code: 'action_not_allowed', message: `${i.type} is not allowed by the local policy` };
    }
    return null;
  }
  if (i.type === 'session.start') {
    if (!c.allowStart) return { code: 'action_not_allowed', message: 'Starting sessions remotely is not allowed by the local policy' };
    if (i.remoteControl) {
      if (c.remoteControl !== true) return { code: 'agent_outdated', message: 'agentd does not support Remote Control yet (update agentd)' };
      if (!c.allowPrompt) return { code: 'action_not_allowed', message: 'Remote Control needs prompt permission (allowPrompt) in the local policy' };
    }
  } else {
    if (i.type === 'session.remote_control') {
      if (c.remoteControl !== true) return { code: 'agent_outdated', message: 'agentd does not support Remote Control yet (update agentd)' };
      if (!c.allowPrompt) return { code: 'action_not_allowed', message: 'Remote Control needs prompt permission (allowPrompt) in the local policy' };
    }
    if (i.type === 'session.prompt' && !c.allowPrompt) return { code: 'action_not_allowed', message: 'Prompting is not allowed by the local policy' };
    if (i.type === 'session.close') {
      if (c.close !== true) return { code: 'agent_outdated', message: 'agentd does not support closing sessions yet (update agentd)' };
      if (!c.allowStop) return { code: 'action_not_allowed', message: 'Closing is not allowed by the local policy (allowStop)' };
    }
    if (i.type === 'session.stop' && !c.allowStop) return { code: 'action_not_allowed', message: 'Stopping is not allowed by the local policy' };
    if (i.type === 'session.set_mode' && !c.allowSetMode) return { code: 'action_not_allowed', message: 'Changing the permission mode is not allowed by the local policy' };
  }
  if ((i.type === 'session.start' || i.type === 'session.set_mode') && i.permissionMode === 'auto' && !c.allowAutoMode) {
    return { code: 'mode_not_allowed', message: 'The auto permission mode is not enabled in the local policy' };
  }

  if (i.session) {
    const tmux = i.session.kind === 'tmux' && i.machineOs !== 'win32';
    const interactive = i.session.kind !== 'bg' && !tmux;
    if (i.type === 'session.remote_control' && !tmux) {
      return i.session.kind === 'bg'
        ? { code: 'remote_control_unsupported', message: 'Remote Control of a background session can only be enabled when it is started (the toggle needs a tmux session)' }
        : { code: 'interactive_session', message: 'Terminal sessions outside tmux cannot be controlled remotely' };
    }
    if (i.type === 'session.close' && !tmux) return { code: 'interactive_session', message: 'Only a session running inside tmux can be closed remotely' };
    if (tmux && i.type === 'session.set_mode') return { code: 'set_mode_unsupported', message: 'The permission mode of a terminal session cannot be changed remotely' };
    if (interactive && i.type !== 'session.stop' && i.type !== 'session.close') return { code: 'interactive_session', message: 'Terminal sessions are view-only (not started with --bg)' };
    if (interactive && i.type === 'session.stop' && i.machineOs === 'win32') return { code: 'interactive_session', message: 'Terminal sessions cannot be interrupted on Windows' };
    if (!interactive && i.type === 'session.set_mode' && !SET_MODE_SUPPORTED_FOR_BG) {
      return { code: 'set_mode_unsupported', message: 'Claude Code cannot change a background session\'s permission mode in place (flags fork a copy)' };
    }
  }
  return null;
}

/** Step-up (ikkinchi tasdiq, Telegram) talab qilinadimi: ochish (har qanday rejim) va `acceptEdits|auto` ga o'tish. */
export function needsStepUp(type: CommandType, permissionMode?: RemotePermissionMode, enableRemoteControl?: boolean): boolean {
  if (type === 'session.start') return true;
  // 6.14: davom ettirish = tmux ichida yangi Claude jarayoni ochish (session.start bilan bir xil ta'sir yuzasi): ikkinchi tasdiq
  if (type === 'session.resume') return true;
  // Remote Control yoqish = sessiyani claude.ai/mobil ilovadan boshqarishga ochish: ikkinchi tasdiq; o'chirish tasdiqsiz (ta'sir yuzasini kamaytiradi).
  if (type === 'session.remote_control') return enableRemoteControl === true;
  // TASKS.md'ga yozish: mavjud qoidalar bo'yicha ikkinchi tasdiq (istisno ro'yxatidagi qurilmalar o'tadi). Haiku xulosa, o'qish va yangilash: yo'q.
  if (type === 'project.append_tasks') return true;
  // PR ochish: branch'ni origin'ga yuboradi va PR yaratadi (tashqi ta'sir): ikkinchi tasdiq (Mac dashboard istisnosi va Telegram inline tasdig'i o'tadi).
  if (type === 'project.open_pr') return true;
  // Deploy ijrosi (6.5): HAR DOIM ikkinchi tasdiq (Mac dashboard istisnosi ham o'tmaydi: `CommandsService`da); checkpoint'dan qaytarish (6.9) ham.
  if (type === 'deploy.run' || type === 'deploy.rollback' || type === 'git.checkpoint_restore') return true;
  if (type === 'session.set_mode') return permissionMode !== undefined && STEP_UP_PERMISSION_MODES.includes(permissionMode);
  return false;
}
