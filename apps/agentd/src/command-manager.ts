import { COMMAND_LIMITS } from '@commander/contracts';
import { isConfigCommandType, isLogsCommandType, isProjectCommandType } from '@commander/contracts';
import type { LogsTail } from './logs-tail.js';
import type { AssistantOps } from './assistant-ask.js';
import type { ProjectScan } from './project-scan.js';
import { isCheckpointCommandType, isDeployCommandType } from '@commander/contracts';
import type { DeployOps } from './deploy-ops.js';
import type { GitCheckpoints } from './git-checkpoints.js';
import { isAssistantCommandType } from '@commander/contracts';
import type { ConfigSync } from './config-sync.js';
import { isGitCommandType } from '@commander/contracts';
import type { AgentControlState, CommandDispatchPayload, CommandErrorCode, CommandResultData } from '@commander/contracts';
import type { GitOps } from './git-ops.js';
import type { ProjectOps } from './project-ops.js';
import type { AgentEntriesLister, AgentEntry } from './agents-full.js';
import { verifyDispatch } from './command-verify.js';
import type { CommandStore, StoredCommand, StoredState } from './command-store.js';
import { errMsg, type Logger } from './logger.js';
import { decidePolicy } from './policy.js';
import type { LoadedPolicy, PolicyDecision } from './policy.js';
import type { CommandRunner, RunnerOutcome } from './runner.js';

export interface CommandTransport {
  isReady(): boolean;
  /** `command.ack` | `command.result` yuboradi; envelope id'sini qaytaradi (ack kutish uchun). `undefined` = yuborilmadi. */
  send(type: 'command.ack' | 'command.result', payload: unknown): string | undefined;
}

export interface CommandManagerDeps {
  store: CommandStore;
  runner: CommandRunner;
  list: AgentEntriesLister;
  policy: () => LoadedPolicy;
  /** PIN qilingan markaz kaliti (config); har chaqiruvda o'qiladi (reset darhol kuchga kirsin). */
  pinnedKey: () => string | undefined;
  deviceId: string;
  log: Logger;
  now?: () => number;
  runningAsRoot: boolean;
  /** Loyiha ish maydoni buyruqlari (2.15). Yo'q bo'lsa `projectOps` e'lon qilinmaydi va bunday buyruqlar rad etiladi. */
  projectOps?: ProjectOps;
  /** Git/PR buyruqlari (3.5): `project.diff|open_pr|ci_status`. Yo'q bo'lsa `gitOps` e'lon qilinmaydi va bunday buyruqlar rad etiladi. */
  gitOps?: GitOps;
  /** Sozlamalar sinxronlash (3.7): `config.*`. Yo'q bo'lsa `configSync` e'lon qilinmaydi va bunday buyruqlar rad etiladi. */
  configSync?: ConfigSync;
  /** Log ko'ruvchi (6.6): `logs.tail`. Yo'q bo'lsa `logs` e'lon qilinmaydi va bunday buyruqlar rad etiladi. */
  logs?: LogsTail;
  /** Commander'dan savol (6.2): `assistant.ask`. Yo'q bo'lsa `assistant` e'lon qilinmaydi va bunday buyruqlar rad etiladi. */
  assistant?: AssistantOps;
  /** Xavfsizlik/dependency tekshiruvi (6.10): `project.scan`. Yo'q bo'lsa `scan` e'lon qilinmaydi va bunday buyruqlar rad etiladi. */
  scan?: ProjectScan;
  /** Deploy (6.5): `deploy.inspect|run|rollback`. Yo'q bo'lsa `deploy` e'lon qilinmaydi va bunday buyruqlar rad etiladi. */
  deploy?: DeployOps;
  /** Git checkpoint (6.9): `git.checkpoint|checkpoint_list|checkpoint_restore`. Yo'q bo'lsa `checkpoints` e'lon qilinmaydi. */
  checkpoints?: GitCheckpoints;
}

/**
 * `command.dispatch` ni qabul qilish tartibi (har bosqich rad etsa `command.result{state:'rejected'}` va JURNALGA yoziladi):
 *   1. commandId takrori -> qayta bajarilmaydi, saqlangan natija qayta yuboriladi;
 *   2. imzo (pin qilingan markaz kaliti) -> muddat;
 *   3. nonce bir martaligi (SQLite UNIQUE: restartdan omon qoladi);
 *   4. lokal siyosat (`policy.json`: yoqilgan, ruxsat, ildiz ichidagi cwd, rejim, maxConcurrentStarted, root emas);
 *   5. `command.ack`, so'ng runner (bitta sessiyaga ketma-ket, `session.start` global ketma-ket).
 * Natijalar markaz `ack` qilguncha jurnalda turadi va qayta ulanganda qayta yuboriladi.
 */
export class CommandManager {
  private readonly now: () => number;
  private transport: CommandTransport | undefined;
  private readonly inflight = new Map<string, { commandId: string; kind: 'ack' | 'result'; state?: StoredState }>();
  private readonly queues = new Map<string, Promise<void>>();
  private startChain: Promise<void> = Promise.resolve();
  private readonly running = new Set<string>();

  constructor(private readonly d: CommandManagerDeps) {
    this.now = d.now ?? Date.now;
  }

  attach(t: CommandTransport): void {
    this.transport = t;
  }

  /** Heartbeat uchun: lokal siyosat holati (yo'llarsiz). */
  controlState(): AgentControlState {
    const r = this.d.policy().policy.remote;
    return {
      enabled: r.enabled,
      allowStart: r.allowStart,
      allowPrompt: r.allowPrompt,
      allowStop: r.allowStop,
      allowSetMode: r.allowSetMode,
      allowAutoMode: r.allowAutoMode,
      maxConcurrentStarted: r.maxConcurrentStarted,
      allowedRootCount: r.allowedRoots.length,
      centerKeyPinned: this.d.pinnedKey() !== undefined,
      runningAsRoot: this.d.runningAsRoot,
      remoteControl: true,
      // 6.14: tugagan terminal sessiyani tmux'da davom ettirish (faqat POSIX'da ma'noli; Windows/tmux yo'q = `resume_unsupported`)
      resume: true,
      close: true,
      ...(this.d.projectOps ? { projectOps: true, allowProjectRead: r.allowProjectRead, allowProjectWrite: r.allowProjectWrite } : {}),
      ...(this.d.gitOps ? { gitOps: true } : {}),
      ...(this.d.configSync ? { configSync: true, allowConfigRead: r.allowConfigRead, allowConfigWrite: r.allowConfigWrite } : {}),
      ...(this.d.assistant ? { assistant: true } : {}),
      ...(this.d.scan ? { scan: true, allowScan: r.allowScan } : {}),
      ...(this.d.deploy ? { deploy: true, allowDeploy: r.allowDeploy, allowDeployShell: r.allowDeployShell } : {}),
      ...(this.d.checkpoints ? { checkpoints: true } : {}),
      ...(this.d.logs ? { logs: true, allowLogs: r.allowLogs, allowedLogRootCount: r.allowedLogRoots.length } : {}),
    };
  }

  pendingCount(): number {
    return this.running.size;
  }

  // --- kirish ----------------------------------------------------------------------------------

  onDispatch(msg: CommandDispatchPayload): void {
    void this.handle(msg).catch((err: unknown) => this.d.log.error('buyruqni qayta ishlashda kutilmagan xato', { commandId: msg.commandId, error: errMsg(err) }));
  }

  async handle(msg: CommandDispatchPayload): Promise<void> {
    const { store, log } = this.d;
    const prior = store.get(msg.commandId);
    if (prior) {
      log.warn('takroriy command.dispatch: qayta bajarilmaydi', { commandId: msg.commandId, state: prior.state });
      this.resend(prior);
      return;
    }

    const bad = verifyDispatch(msg, { pinnedKey: this.d.pinnedKey(), deviceId: this.d.deviceId, now: this.now() });
    if (bad) {
      // Imzo yaroqsiz bo'lsa ham nonce'ni jurnalga yozamiz (xuddi shu paketni qayta yuborish ham rad etiladi).
      this.recordRejected(msg, bad.code, bad.message);
      return;
    }
    const begun = store.begin(msg.commandId, msg.nonce, msg.type);
    if (begun !== 'ok') {
      log.warn('REPLAY rad etildi', { commandId: msg.commandId, reason: begun });
      if (begun === 'replayed_nonce') this.sendResult(msg.commandId, 'rejected', undefined, { code: 'replay', message: 'The nonce was already used' }, false);
      else this.resend(store.get(msg.commandId)!);
      return;
    }

    let entry: AgentEntry | undefined;
    let decision: PolicyDecision;
    try {
      ({ decision, entry } = await this.decide(msg));
    } catch (err) {
      this.finish(msg.commandId, 'rejected', undefined, { code: 'internal', message: 'policy check failed' });
      log.error('siyosat tekshiruvi xatosi', { commandId: msg.commandId, error: errMsg(err) });
      return;
    }
    if (!decision.ok) {
      log.warn('buyruq lokal siyosat bilan rad etildi', { commandId: msg.commandId, type: msg.type, code: decision.code });
      this.finish(msg.commandId, 'rejected', undefined, { code: decision.code, message: decision.message });
      return;
    }

    this.sendAck(msg.commandId);
    this.running.add(msg.commandId);
    const key = msg.type === 'session.start' ? '__start__' : isLogsCommandType(msg.type) ? `logs:${msg.commandId}` : isAssistantCommandType(msg.type) ? '__assistant__' : msg.type === 'project.scan' ? '__scan__' : isConfigCommandType(msg.type) ? '__config__' : isDeployCommandType(msg.type) ? `${msg.type === 'deploy.inspect' ? 'deploy-inspect' : 'deploy'}:${(msg.payload as { root: string }).root}` : isCheckpointCommandType(msg.type) ? `git:${(msg.payload as { root: string }).root}` : isGitCommandType(msg.type) ? `git:${(msg.payload as { root: string }).root}` : isProjectCommandType(msg.type) ? `project:${(msg.payload as { root: string }).root}` : (msg.payload as { claudeSessionId: string }).claudeSessionId;
    const prev = key === '__start__' ? this.startChain : (this.queues.get(key) ?? Promise.resolve());
    const run = prev.then(() => this.execute(msg, decision, entry)).catch(() => undefined);
    if (key === '__start__') this.startChain = run;
    else {
      this.queues.set(key, run);
      void run.then(() => {
        if (this.queues.get(key) === run) this.queues.delete(key);
      });
    }
  }

  // --- qaror -----------------------------------------------------------------------------------

  private async decide(msg: CommandDispatchPayload): Promise<{ decision: PolicyDecision; entry?: AgentEntry }> {
    const policy = this.d.policy().policy;
    const base = { policy, runningAsRoot: this.d.runningAsRoot };
    if (isAssistantCommandType(msg.type)) {
      if (!this.d.assistant) return { decision: { ok: false, code: 'action_not_allowed', message: 'This agentd does not support the assistant' } };
      return { decision: decidePolicy({ ...base, type: msg.type }) };
    }
    if (isLogsCommandType(msg.type)) {
      if (!this.d.logs) return { decision: { ok: false, code: 'action_not_allowed', message: 'This agentd does not support log viewing' } };
      return { decision: decidePolicy({ ...base, type: msg.type }) };
    }
    if (isDeployCommandType(msg.type) || isCheckpointCommandType(msg.type)) {
      if (isDeployCommandType(msg.type) ? !this.d.deploy : !this.d.checkpoints) return { decision: { ok: false, code: 'action_not_allowed', message: `This agentd does not support ${msg.type}` } };
      return { decision: decidePolicy({ ...base, type: msg.type, cwd: (msg.payload as { root: string }).root }) };
    }
    if (isConfigCommandType(msg.type)) {
      if (!this.d.configSync) return { decision: { ok: false, code: 'action_not_allowed', message: 'This agentd does not support config sync' } };
      return { decision: decidePolicy({ ...base, type: msg.type, dryRun: msg.type === 'config.apply' && msg.payload.dryRun }) };
    }
    if (isProjectCommandType(msg.type)) {
      if (!this.d.projectOps) return { decision: { ok: false, code: 'action_not_allowed', message: 'This agentd does not support project commands' } };
      if (msg.type === 'project.scan' && !this.d.scan) return { decision: { ok: false, code: 'action_not_allowed', message: 'This agentd does not support project scans' } };
      if (isGitCommandType(msg.type) && !this.d.gitOps) return { decision: { ok: false, code: 'action_not_allowed', message: 'This agentd does not support git commands' } };
      return { decision: decidePolicy({ ...base, type: msg.type, cwd: (msg.payload as { root: string }).root }) };
    }
    if (msg.type === 'session.start') {
      const live = await this.liveStarted();
      // 3.10: Remote Control bilan ochish = sessiyani claude.ai'dan boshqarishga ochish: prompt ruxsati ham kerak.
      if (msg.payload.remoteControl && !policy.remote.allowPrompt) {
        return { decision: { ok: false, code: 'action_not_allowed', message: 'Remote Control needs allowPrompt in the local policy' } };
      }
      return { decision: decidePolicy({ ...base, type: msg.type, cwd: msg.payload.cwd, permissionMode: msg.payload.permissionMode, liveStarted: live }) };
    }
    if (msg.type === 'session.resume') {
      // 6.14: sessiya `claude agents`da TIRIK emas (tugagan) bo'lishi kerak: ro'yxatdan qidirilmaydi; cwd markazdan, siyosat (ildiz) bilan tekshiriladi.
      // Tirik/nusxa himoyasi runner'da (agents + supervisor + ps).
      return { decision: decidePolicy({ ...base, type: msg.type, cwd: msg.payload.cwd, liveStarted: await this.liveStarted() }) };
    }
    // Avval siyosatning yoqilgan/ruxsat qismi (sessiya ma'lumotini ochmasdan), keyin sessiya va uning cwd'si.
    const pre = decidePolicy({ ...base, type: msg.type, cwd: '/', ...(msg.type === 'session.set_mode' ? { permissionMode: msg.payload.permissionMode } : {}) });
    if (!pre.ok && pre.code !== 'cwd_not_allowed' && pre.code !== 'cwd_invalid') return { decision: pre };

    const entry = (await this.d.list()).find((e) => e.claudeSessionId === (msg.payload as { claudeSessionId: string }).claudeSessionId);
    if (!entry) return { decision: { ok: false, code: 'session_not_found', message: 'The session is not listed by `claude agents`' } };
    if (msg.type === 'session.stop') return { decision: decidePolicy({ ...base, type: msg.type }), entry }; // to'xtatish ildizga bog'liq emas
    if (msg.type === 'session.close') {
      // 6.14: faqat tmux ichidagi sessiya yopiladi (pane tekshiriladi); ildizga bog'liq emas (stop kabi)
      if (entry.kind === 'bg' || !(await this.d.runner.hasTmuxPane(entry))) return { decision: { ok: false, code: 'interactive_session', message: 'Only a session running inside tmux can be closed remotely' }, entry };
      return { decision: decidePolicy({ ...base, type: msg.type }), entry };
    }
    if (entry.kind !== 'bg') {
      // Terminal sessiya: faqat tmux ichidagi interaktiv sessiyaga PROMPT (siyosat + sessiya cwd'i allowedRoots ichida); qolgani ko'rish.
      if ((msg.type === 'session.prompt' || msg.type === 'session.remote_control') && (await this.d.runner.hasTmuxPane(entry))) return { decision: decidePolicy({ ...base, type: msg.type, cwd: entry.cwd }), entry };
      return { decision: { ok: false, code: 'interactive_session', message: 'Terminal sessions are view-only (not running inside tmux)' }, entry };
    }
    return { decision: decidePolicy({ ...base, type: msg.type, cwd: entry.cwd, ...(msg.type === 'session.set_mode' ? { permissionMode: msg.payload.permissionMode } : {}) }), entry };
  }

  /** Biz ochgan va hozir TIRIK (pid bor) sessiyalar soni. */
  private async liveStarted(): Promise<number> {
    const ours = new Set(this.d.store.startedSessionIds());
    if (ours.size === 0) return 0;
    return (await this.d.list()).filter((e) => ours.has(e.claudeSessionId) && e.pid !== undefined).length;
  }

  // --- bajarish --------------------------------------------------------------------------------

  private async execute(msg: CommandDispatchPayload, decision: Extract<PolicyDecision, { ok: true }>, entry: AgentEntry | undefined): Promise<void> {
    const id = msg.commandId;
    try {
      if (this.now() >= msg.expiresAt + COMMAND_LIMITS.dispatchTtlMs) {
        // Navbatda juda uzoq kutdi: eskirgan buyruq bajarilmasin.
        this.finish(id, 'failed', undefined, { code: 'expired', message: 'The command waited too long in the local queue' });
        return;
      }
      let out: RunnerOutcome;
      switch (msg.type) {
        case 'session.start':
          out = await this.d.runner.start(msg.payload, decision.cwdReal!);
          break;
        case 'session.resume':
          out = await this.d.runner.resume(msg.payload, decision.cwdReal!);
          break;
        case 'session.prompt': {
          // Navbatdan keyin sessiya holati o'zgargan bo'lishi mumkin: qayta o'qiymiz.
          const fresh = (await this.d.runner.findEntry(msg.payload.claudeSessionId)) ?? entry;
          out = fresh ? await this.d.runner.prompt(msg.payload, fresh) : { ok: false, code: 'session_not_found', message: 'The session disappeared' };
          break;
        }
        case 'session.stop': {
          const fresh = (await this.d.runner.findEntry(msg.payload.claudeSessionId)) ?? entry;
          out = fresh ? await this.d.runner.stop(msg.payload, fresh) : { ok: false, code: 'session_not_found', message: 'The session disappeared' };
          break;
        }
        case 'session.close': {
          const fresh = (await this.d.runner.findEntry(msg.payload.claudeSessionId)) ?? entry;
          out = fresh ? await this.d.runner.close(msg.payload, fresh) : { ok: false, code: 'session_not_found', message: 'The session disappeared' };
          break;
        }
        case 'session.set_mode':
          out = this.d.runner.setMode(msg.payload);
          break;
        case 'session.remote_control': {
          const fresh = (await this.d.runner.findEntry(msg.payload.claudeSessionId)) ?? entry;
          out = fresh ? await this.d.runner.remoteControl(msg.payload, fresh) : { ok: false, code: 'session_not_found', message: 'The session disappeared' };
          break;
        }
        case 'assistant.ask':
          out = await this.assistantOps().ask(msg.payload);
          break;
        case 'logs.tail':
          out = await this.logsTail().tail(id, msg.payload);
          break;
        case 'config.capture':
          out = await this.cfg().capture(msg.payload);
          break;
        case 'config.apply':
          out = await this.cfg().apply(msg.payload);
          break;
        case 'config.rollback':
          out = await this.cfg().rollback(msg.payload);
          break;
        case 'project.refresh':
          out = await this.ops().refresh(decision.cwdReal ?? msg.payload.root);
          break;
        case 'project.read_md':
          out = this.ops().readMd({ ...msg.payload, root: decision.cwdReal ?? msg.payload.root });
          break;
        case 'project.append_tasks':
          out = await this.ops().appendTasks({ ...msg.payload, root: decision.cwdReal ?? msg.payload.root });
          break;
        case 'project.summarize':
          out = await this.ops().summarize({ ...msg.payload, root: decision.cwdReal ?? msg.payload.root });
          break;
        case 'project.diff':
          out = await this.git().diff({ ...msg.payload, root: decision.cwdReal ?? msg.payload.root });
          break;
        case 'project.open_pr':
          out = await this.git().openPr({ ...msg.payload, root: decision.cwdReal ?? msg.payload.root });
          break;
        case 'project.scan':
          out = await this.scanOps().scan(decision.cwdReal ?? msg.payload.root);
          break;
        case 'deploy.inspect':
          out = await this.deployOps().inspect(msg.payload, decision.cwdReal ?? msg.payload.root);
          break;
        case 'deploy.run':
          out = await this.deployOps().execute(id, 'run', msg.payload, decision.cwdReal ?? msg.payload.root);
          break;
        case 'deploy.rollback':
          out = await this.deployOps().execute(id, 'rollback', msg.payload, decision.cwdReal ?? msg.payload.root);
          break;
        case 'git.checkpoint':
          out = await this.ckpt().create({ ...msg.payload, root: decision.cwdReal ?? msg.payload.root });
          break;
        case 'git.checkpoint_list':
          out = await this.ckpt().list({ root: decision.cwdReal ?? msg.payload.root });
          break;
        case 'git.checkpoint_restore':
          out = await this.ckpt().restore({ ...msg.payload, root: decision.cwdReal ?? msg.payload.root });
          break;
        case 'project.ci_status':
          out = await this.git().ciStatus({ ...msg.payload, root: decision.cwdReal ?? msg.payload.root });
          break;
      }
      if (out.ok) this.finish(id, 'done', out.result);
      else this.finish(id, 'failed', out.result, { code: out.code ?? 'internal', message: out.message ?? 'failed' });
    } catch (err) {
      this.d.log.error('runner kutilmagan xato', { commandId: id, type: msg.type, error: errMsg(err) });
      this.finish(id, 'failed', undefined, { code: 'internal', message: 'unexpected runner error' });
    } finally {
      this.running.delete(id);
    }
  }

  private assistantOps(): AssistantOps {
    if (!this.d.assistant) throw new Error('assistant is not configured');
    return this.d.assistant;
  }

  private deployOps(): DeployOps {
    if (!this.d.deploy) throw new Error('deploy is not configured');
    return this.d.deploy;
  }

  private ckpt(): GitCheckpoints {
    if (!this.d.checkpoints) throw new Error('checkpoints is not configured');
    return this.d.checkpoints;
  }

  private scanOps(): ProjectScan {
    if (!this.d.scan) throw new Error('scan is not configured');
    return this.d.scan;
  }

  private logsTail(): LogsTail {
    if (!this.d.logs) throw new Error('logs is not configured');
    return this.d.logs;
  }

  private git(): GitOps {
    if (!this.d.gitOps) throw new Error('gitOps is not configured');
    return this.d.gitOps;
  }

  private cfg(): ConfigSync {
    if (!this.d.configSync) throw new Error('configSync is not configured');
    return this.d.configSync;
  }

  private ops(): ProjectOps {
    if (!this.d.projectOps) throw new Error('projectOps is not configured');
    return this.d.projectOps;
  }

  // --- natijalarni markazga yetkazish ----------------------------------------------------------

  private recordRejected(msg: CommandDispatchPayload, code: CommandErrorCode, message: string): void {
    this.d.log.warn('buyruq rad etildi (imzo/muddat)', { commandId: msg.commandId, type: msg.type, code });
    // nonce UNIQUE: boshqa buyruq nonce'ini "ishlatib" bo'lmaydi; to'qnashsa faqat natija yuboriladi.
    const begun = this.d.store.begin(msg.commandId, msg.nonce, msg.type);
    if (begun === 'ok') this.finish(msg.commandId, 'rejected', undefined, { code, message });
    else this.sendResult(msg.commandId, 'rejected', undefined, { code, message }, false);
  }

  private finish(commandId: string, state: Exclude<StoredState, 'received' | 'running'>, result?: CommandResultData, error?: { code: string; message: string }): void {
    this.d.store.setState(commandId, state, result, error);
    this.sendResult(commandId, state, result, error, true);
  }

  private sendAck(commandId: string): void {
    this.d.store.markAckSent(commandId);
    const id = this.transport?.isReady() ? this.transport.send('command.ack', { commandId }) : undefined;
    if (id) this.inflight.set(id, { commandId, kind: 'ack' });
  }

  private sendResult(commandId: string, state: StoredState, result: CommandResultData | undefined, error: { code: string; message: string } | undefined, persisted: boolean): void {
    if (!this.transport?.isReady()) return; // qayta ulanganda jurnaldan qayta yuboriladi
    const id = this.transport.send('command.result', { commandId, state, ...(result ? { result } : {}), ...(error ? { error: { code: error.code, message: error.message.slice(0, 500) } } : {}) });
    if (id && persisted) this.inflight.set(id, { commandId, kind: 'result', state });
    else if (id) this.inflight.set(id, { commandId, kind: 'result', state });
  }

  private resend(c: StoredCommand): void {
    if (c.state === 'received') return;
    if (c.ackSent && !c.ackConfirmed) this.sendAck(c.commandId);
    if (!c.resultConfirmed) this.sendResult(c.commandId, c.state, c.result ?? undefined, c.error ?? undefined, true);
  }

  /** Markaz `ack {ids}` yubordi: shu envelope id'lar bizning ack/result xabarlarimiz bo'lsa jurnalda tasdiqlanadi. `true` = bizniki edi. */
  onAck(ids: string[]): boolean {
    let mine = false;
    for (const id of ids) {
      const f = this.inflight.get(id);
      if (!f) continue;
      this.inflight.delete(id);
      mine = true;
      if (f.kind === 'ack') this.d.store.confirmAck(f.commandId);
      else if (f.state) this.d.store.confirmResult(f.commandId, f.state);
    }
    return mine;
  }

  /** Markaz nack qildi: qayta yuborilmaydi (center bu buyruqni bilmaydi); jurnalda tasdiqlangan deb belgilanadi. */
  onNack(id: string | undefined): boolean {
    if (!id) return false;
    const f = this.inflight.get(id);
    if (!f) return false;
    this.inflight.delete(id);
    if (f.kind === 'ack') this.d.store.confirmAck(f.commandId);
    else if (f.state) this.d.store.confirmResult(f.commandId, f.state);
    this.d.log.warn('center command xabarini rad etdi', { commandId: f.commandId, kind: f.kind });
    return true;
  }

  /** Ulanish (qayta) o'rnatildi: markaz tasdiqlamagan ack/natijalar qayta yuboriladi. */
  onReady(): void {
    for (const c of this.d.store.unconfirmed()) this.resend(c);
  }

  onClosed(): void {
    this.inflight.clear();
  }
}
