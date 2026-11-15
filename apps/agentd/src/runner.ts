import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import type { ClosePayload, CommandErrorCode, CommandResultData, PromptPayload, RemoteControlPayload, RemoteControlResult, RemotePermissionMode, ResumePayload, SetModePayload, StartPayload, StopPayload } from '@commander/contracts';
import type { AgentEntriesLister, AgentEntry } from './agents-full.js';
import { runClaude } from './claude-exec.js';
import { errMsg, type Logger } from './logger.js';
import { bridgeUrl, readBridgeSessionId, readBridgeState, safeRcName, toggleRemoteControl } from './remote-control.js';
import type { BridgeState } from './remote-control.js';
import { STILL_RUNNING_MESSAGE, RESUME_UNSUPPORTED_MESSAGE, buildResumeShellCommand, classifyResumed, liveVerdict, tmuxResumeName } from './resume-logic.js';
import { claudeProjectsRoot, resolveTranscript } from './chat-path.js';
import { resolveExecutable } from './trusted-bin.js';
import { TMUX_PROMPT_MAX, checkPromptModeChar, newBufferName, planCloseSteps, planInterruptSteps, planPromptSteps, tmuxSessionOfLabel, sanitizePromptText, type TmuxLocator, type TmuxMatch, type TmuxTarget } from './tmux.js';

/**
 * Runner: `claude` CLI orqali sessiya ochish / prompt / to'xtatish. HAMMA chaqiruv argumentlar MASSIVI bilan (shell YO'Q);
 * foydalanuvchi matni `--` dan KEYIN beriladi (matn `-` bilan boshlansa ham bayroq bo'lib o'qilmaydi: 2026-11-13 tekshirilgan).
 * Windows `.cmd/.bat` shim (cmd.exe orqali) erkin matnni xavfsiz o'tkaza olmaydi: `claude-exec` rad etadi -> `shim_unsupported`.
 *
 * Aniqlangan faktlar (Claude Code 2.1.304, macOS, spike 2026-11-13):
 *  - `claude --bg ...` stdout: `backgrounded · <8 belgi id> · <nom>`; `claude stop|attach` FAQAT shu qisqa id'ni qabul qiladi;
 *  - `claude stop` asinxron: qaytgandan keyin ham bir necha soniya "ishlayapti" ko'rinadi; shu vaqtda `--resume` NUSXA (fork) ochadi,
 *    shuning uchun `pid` yo'qolguncha kutiladi;
 *  - `claude --bg --resume <id>` BAYROQSIZ: xuddi shu sessiya saqlangan opsiyalar bilan davom etadi; bayroq berilsa NUSXA ochiladi
 *    (shuning uchun `set_mode` boshqariladigan sessiyada qo'llab-quvvatlanmaydi).
 */

export interface RunnerOutcome {
  ok: boolean;
  result?: CommandResultData;
  code?: CommandErrorCode;
  message?: string;
}

const okOutcome = (result: CommandResultData): RunnerOutcome => ({ ok: true, result });
const fail = (code: CommandErrorCode, message: string): RunnerOutcome => ({ ok: false, code, message });

export const MODE_TO_CLI: Record<RemotePermissionMode, string> = { default: 'manual', acceptEdits: 'acceptEdits', plan: 'plan', auto: 'auto' };

/** `claude --bg ...` argumentlari (sof). `cwd` execFile ga alohida beriladi. */
export function buildStartArgs(p: StartPayload): string[] {
  return [
    '--bg',
    // 3.10: `--remote-control [nom]` (nom bo'lmasa bayroqdan keyin doim boshqa `--...` bayroq keladi: `--permission-mode`)
    ...(p.remoteControl ? ['--remote-control', ...(p.name ? [p.name] : [])] : []),
    ...(p.name ? ['-n', p.name] : []),
    ...(p.model ? ['--model', p.model] : []),
    '--permission-mode',
    MODE_TO_CLI[p.permissionMode],
    '--',
    p.prompt,
  ];
}

/** Prompt: to'xtatilgan bg sessiyani BAYROQSIZ davom ettirish (bayroq = nusxa!). */
export function buildResumeArgs(claudeSessionId: string, text: string): string[] {
  return ['--bg', '--resume', claudeSessionId, '--', text];
}

export function buildStopArgs(shortId: string): string[] {
  return ['stop', shortId];
}

const BACKGROUNDED_RE = /backgrounded\s*[·.]\s*([0-9a-f]{8})/;
const COPY_RE = /started a copy as ([0-9a-f]{8})/;

export function parseBackgrounded(stdout: string): { shortId: string | null; copyOf: string | null } {
  return { shortId: BACKGROUNDED_RE.exec(stdout)?.[1] ?? null, copyOf: COPY_RE.exec(stdout)?.[1] ?? null };
}

export interface ProcInfo {
  uid: number;
  command: string;
}

export interface RunnerDeps {
  claudeBin: string;
  list: AgentEntriesLister;
  log: Logger;
  /** Testlar uchun almashtiriladi. */
  exec?: (args: string[], opts: { cwd?: string; timeoutMs: number }) => Promise<string>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Interaktiv sessiyani to'xtatish uchun (POSIX): jarayon egasi va buyrug'ini beradi. */
  procInfo?: (pid: number) => Promise<ProcInfo | null>;
  signal?: (pid: number, sig: 'SIGINT') => void;
  platform?: string;
  uid?: number | undefined;
  timeouts?: { resumeMs?: number; closeMs?: number; rcConfirmMs?: number; startMs?: number; stopWaitMs?: number; correlateMs?: number; pollMs?: number; resumeSettleMs?: number };
  /** Claude fon supervisor'i shu sessiyani hali "worker" sifatida ushlab turibdimi (testlar uchun almashtiriladi). */
  supervisorHolds?: (shortId: string) => boolean;
  /** tmux ichidagi terminal sessiyalarni boshqarish (2.6). Yo'q bo'lsa terminal sessiyaga prompt yuborilmaydi. */
  tmux?: TmuxLocator;
  /** Remote Control (3.10): sessiya fayli (`<pid>.json`) dagi bridge id (testlar uchun almashtiriladi). */
  bridgeId?: (pid: number) => string | null;
  bridgeState?: (pid: number) => BridgeState;
  /** agentd lokal hook holati (`awaiting_approval` bo'lsa tmux orqali matn yozilmaydi: ruxsat dialogiga tushib ketmasin). */
  localStatus?: (claudeSessionId: string) => string | undefined;
  /** 6.14: transkript shu mashinada bormi (testlar uchun almashtiriladi). Default: `~/.claude/projects/*\/<id>.jsonl`. */
  transcriptExists?: (claudeSessionId: string) => Promise<boolean>;
  /** 6.14: ishlayotgan jarayonlarning buyruq qatorlari (`ps -A -o command=`); testlar uchun almashtiriladi. */
  psLines?: () => Promise<string[]>;
  /** 6.14: agentd o'zi yaratgan tmux sessiya nomlari (faqat shularni `kill-session` qilish mumkin). */
  ownedTmux?: () => string[];
}

/**
 * Jonli o'lchov (CC 2.1.304): `claude stop` dan keyin pid darhol yo'qoladi, lekin supervisor worker'ni
 * `<config>/daemon/roster.json` da yana ~1-2 s ushlab turadi; shu oraliqda `--resume` NUSXA ochadi.
 * Fayl yo'q yoki o'qib bo'lmasa — ushlab turmaydi deb hisoblaymiz (keyin baribir settle kutiladi).
 */
function defaultSupervisorHolds(shortId: string): boolean {
  const dir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
  try {
    const roster: unknown = JSON.parse(readFileSync(join(dir, 'daemon', 'roster.json'), 'utf8'));
    const workers = (roster as { workers?: unknown } | null)?.workers;
    return typeof workers === 'object' && workers !== null && Object.prototype.hasOwnProperty.call(workers, shortId);
  } catch {
    return false;
  }
}

/** Argumentlarni (prompt!) xatoga/logga YOZMASLIK uchun: faqat chiqish kodi. */
function describeExecError(err: unknown): string {
  if (err instanceof Error && /fixed literal|sobit literal|xavfli belgilar/.test(err.message)) return 'shim';
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'number' ? `exit ${code}` : typeof code === 'string' ? code : 'failed';
}

const defaultPsLines = (): Promise<string[]> =>
  new Promise((resolve) => {
    execFile('/bin/ps', ['-A', '-o', 'command='], { timeout: 5000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => resolve(err ? [] : stdout.split('\n')));
  });

const defaultTranscriptExists = async (claudeSessionId: string): Promise<boolean> => (await resolveTranscript({ root: claudeProjectsRoot(), claudeSessionId })).ok;

const defaultProcInfo = (pid: number): Promise<ProcInfo | null> =>
  new Promise((resolve) => {
    execFile('/bin/ps', ['-o', 'uid=,command=', '-p', String(pid)], { timeout: 3000 }, (err, stdout) => {
      if (err) return resolve(null);
      const m = /^\s*(\d+)\s+(.*)$/s.exec(stdout.trim());
      resolve(m ? { uid: Number(m[1]), command: m[2] ?? '' } : null);
    });
  });

export class CommandRunner {
  private readonly exec: NonNullable<RunnerDeps['exec']>;
  private readonly sleep: NonNullable<RunnerDeps['sleep']>;
  private readonly now: () => number;
  private readonly platform: string;

  constructor(private readonly d: RunnerDeps) {
    this.exec = d.exec ?? ((args, o) => runClaude(d.claudeBin, args, { timeout: o.timeoutMs, ...(o.cwd ? { cwd: o.cwd } : {}) }));
    this.sleep = d.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = d.now ?? Date.now;
    this.platform = d.platform ?? process.platform;
  }

  private get t() {
    return { closeMs: this.d.timeouts?.closeMs ?? 10_000, resumeMs: this.d.timeouts?.resumeMs ?? 30_000, startMs: this.d.timeouts?.startMs ?? 60_000, stopWaitMs: this.d.timeouts?.stopWaitMs ?? 20_000, correlateMs: this.d.timeouts?.correlateMs ?? 15_000, pollMs: this.d.timeouts?.pollMs ?? 500, resumeSettleMs: this.d.timeouts?.resumeSettleMs ?? 2_000 };
  }

  async findEntry(claudeSessionId: string): Promise<AgentEntry | undefined> {
    return (await this.d.list()).find((e) => e.claudeSessionId === claudeSessionId);
  }

  /** `session.start`: `claude --bg` -> qisqa id -> `agents --json` bilan sessionId'ga bog'lash. `cwdReal` allaqachon siyosatdan o'tgan. */
  async start(p: StartPayload, cwdReal: string): Promise<RunnerOutcome> {
    const modeErr = checkPromptModeChar(p.prompt);
    if (modeErr) return fail('invalid_payload', modeErr);
    let before: Set<string>;
    try {
      before = new Set((await this.d.list()).map((e) => e.claudeSessionId));
    } catch (err) {
      return fail('claude_failed', `claude agents failed (${describeExecError(err)})`);
    }
    const t0 = this.now();
    let stdout: string;
    try {
      stdout = await this.exec(buildStartArgs(p), { cwd: cwdReal, timeoutMs: this.t.startMs });
    } catch (err) {
      const why = describeExecError(err);
      return why === 'shim' ? fail('shim_unsupported', 'Windows .cmd shims cannot pass free text safely; install the native claude.exe') : fail('claude_failed', `claude --bg failed (${why})`);
    }
    const { shortId } = parseBackgrounded(stdout);

    const deadline = this.now() + this.t.correlateMs;
    for (;;) {
      let entries: AgentEntry[] = [];
      try {
        entries = await this.d.list();
      } catch (err) {
        this.d.log.warn('agents --json (correlation) failed', { error: errMsg(err) });
      }
      const byId = shortId ? entries.find((e) => e.shortId === shortId) : undefined;
      if (byId) return this.finishStart(p, byId, 'started');
      if (!shortId) {
        // stdout'dan id olinmadi: faqat YAGONA yangi bg yozuv (shu cwd, t0 dan keyin) bo'lsa ishonamiz.
        const cands = entries.filter((e) => e.kind === 'bg' && !before.has(e.claudeSessionId) && (e.startedAt ?? 0) >= t0 - 2_000 && e.cwd === cwdReal);
        if (cands.length === 1) return this.finishStart(p, cands[0]!, 'started (correlated by cwd)');
      }
      if (this.now() >= deadline) return fail('correlation_timeout', 'The session was started but could not be matched in `claude agents --json`');
      await this.sleep(this.t.pollMs);
    }
  }

  /**
   * 6.14 `session.resume`: tugagan terminal sessiyani `claude --resume <id>` bilan YANGI tmux sessiyada davom ettirish.
   * `cwdReal` allaqachon siyosatdan o'tgan (allowedRoots ichida). Tartib: platforma/tmux -> nusxa himoyasi (tirik jarayon/supervisor/ps)
   * -> transkript bor -> `tmux new-session -d` -> pane daraxtidagi claude'ning sessionId'si so'ralganiga TENGligini tasdiqlash.
   * Nusxa chiqsa tmux sessiya o'chiriladi (`resume_forked`); muddat tugasa ham o'chiriladi (yarim ochilgan jarayon qolmasin).
   */
  async resume(p: ResumePayload, cwdReal: string): Promise<RunnerOutcome> {
    const tmux = this.d.tmux;
    if (this.platform === 'win32' || !tmux || !(await tmux.isAvailable())) return fail('resume_unsupported', RESUME_UNSUPPORTED_MESSAGE);
    const bin = resolveExecutable(this.d.claudeBin, 'claude') ?? this.d.claudeBin;
    if (!isAbsolute(bin)) return fail('claude_failed', 'claude was not found in the trusted PATH (set an absolute claudeBin)');
    let shellCommand: string;
    try {
      shellCommand = buildResumeShellCommand(bin, p.claudeSessionId);
      if (/['\0\r\n]/.test(cwdReal)) throw new Error('unsafe cwd');
    } catch {
      return fail('claude_failed', 'The claude path or cwd has characters that cannot be passed to tmux safely');
    }

    // 1. nusxa himoyasi: sessiya hali tirikmi
    let entries: AgentEntry[];
    try {
      entries = await this.d.list();
    } catch (err) {
      return fail('claude_failed', `claude agents failed (${describeExecError(err)})`);
    }
    const holds = this.d.supervisorHolds ?? defaultSupervisorHolds;
    const verdict = liveVerdict(entries, p.claudeSessionId, { holds, psLines: await (this.d.psLines ?? defaultPsLines)() });
    if (verdict.live) {
      this.d.log.warn('session.resume rad etildi: sessiya hali tirik', { why: verdict.why });
      return fail('session_still_running', STILL_RUNNING_MESSAGE);
    }
    if (!(await (this.d.transcriptExists ?? defaultTranscriptExists)(p.claudeSessionId))) return fail('session_not_found', 'The conversation transcript was not found on this machine (cannot resume)');

    // 2. tmux nomi (band bo'lsa qisqa qo'shimcha)
    let name = tmuxResumeName(p.claudeSessionId);
    if (await tmux.hasSession(name)) name = tmuxResumeName(p.claudeSessionId, Math.floor(Math.random() * 4096).toString(16).padStart(3, '0'));
    if (await tmux.hasSession(name)) return fail('internal', 'The tmux session name is already taken');
    try {
      await tmux.newDetachedSession({ name, cwd: cwdReal, shellCommand });
    } catch (err) {
      return fail('claude_failed', `tmux new-session failed (${errMsg(err)})`);
    }

    // 3. tasdiqlash: pane daraxtidagi claude'ning sessionId'si
    const deadline = this.now() + this.t.resumeMs;
    const abort = async (out: RunnerOutcome): Promise<RunnerOutcome> => {
      await tmux.killSession(name);
      return out;
    };
    for (;;) {
      const panePid = await tmux.sessionPanePid(name);
      if (panePid === undefined) return fail('claude_failed', 'claude exited right after start (the conversation could not be resumed from this folder)');
      let live: AgentEntry[] = [];
      try {
        live = (await this.d.list()).filter((e) => e.pid !== undefined);
      } catch (err) {
        this.d.log.warn('agents --json (resume) failed', { error: errMsg(err) });
      }
      const ours: AgentEntry[] = [];
      for (const e of live) if (await tmux.descendsFrom(e.pid as number, panePid)) ours.push(e);
      const c = classifyResumed(ours, p.claudeSessionId);
      if (c.kind === 'ok') return okOutcome({ claudeSessionId: p.claudeSessionId, tmuxSession: name, detail: `tmux attach -t ${name}` });
      if (c.kind === 'forked') return abort(fail('resume_forked', 'Claude opened a copy of the conversation instead of continuing it; the tmux session was closed'));
      if (this.now() >= deadline) return abort(fail('correlation_timeout', 'The resumed session did not register in time (a dialog may be waiting in the tmux session); it was closed'));
      await this.sleep(this.t.pollMs);
    }
  }

  /**
   * 6.14 `session.close`: tmux ichidagi sessiyani yopish. (1) pane qayta tekshiriladi; (2) Escape + `/exit` + Enter (sobit matn, prompt emas);
   * (3) `closeMs` gacha claude jarayoni yo'qolishi kutiladi; (4) tmux sessiyani agentd O'ZI yaratgan bo'lsa (`ownedTmux`) va hali tirik bo'lsa
   * `kill-session`. Foydalanuvchining o'z tmux sessiyasi HECH QACHON o'ldirilmaydi (faqat graceful `/exit`). Natija halol: jarayon ketmasa `close_failed`.
   */
  async close(p: ClosePayload, entry: AgentEntry): Promise<RunnerOutcome> {
    const fresh = (await this.findEntry(entry.claudeSessionId).catch(() => undefined)) ?? entry;
    if (fresh.pid === undefined) return okOutcome({ claudeSessionId: p.claudeSessionId, detail: 'already closed' });
    if (this.d.localStatus?.(fresh.claudeSessionId) === 'awaiting_approval') return fail('session_busy', 'The session is waiting for a permission decision; answer it first');
    const v = await this.verifiedPane(fresh);
    if ('out' in v) return v.out;
    const tmux = this.d.tmux!;
    const sessName = tmuxSessionOfLabel(v.target.label);
    const owned = sessName !== '' && (this.d.ownedTmux?.() ?? []).includes(sessName);
    try {
      await tmux.run(v.target, planCloseSteps(v.target.paneId), this.sleep);
    } catch (err) {
      return fail('close_failed', `tmux send failed (${errMsg(err)})`);
    }
    const gone = async (): Promise<boolean> => {
      const cur = await this.findEntry(p.claudeSessionId).catch(() => fresh);
      return !cur || cur.pid === undefined;
    };
    const deadline = this.now() + this.t.closeMs;
    let exited = false;
    for (;;) {
      if (await gone()) {
        exited = true;
        break;
      }
      if (this.now() >= deadline) break;
      await this.sleep(this.t.pollMs);
    }
    let killed = false;
    if (owned && (await tmux.hasSession(sessName))) {
      await tmux.killSession(sessName);
      killed = true;
      if (!exited) {
        await this.sleep(this.t.pollMs);
        exited = await gone();
      }
    }
    if (!exited) return fail('close_failed', owned ? 'Claude did not exit in time' : 'Claude did not exit after /exit; the tmux session is not Commander\'s, so it was left alone');
    return okOutcome({ claudeSessionId: p.claudeSessionId, detail: killed ? 'exited; tmux session killed' : 'exited gracefully (/exit)' });
  }

  /** `session.start` yakuni: RC so'ralgan bo'lsa sessiya faylidagi bridge id bilan TASDIQLANADI (tasdiqlanmasa natijada `remoteControl` yo'q). */
  private async finishStart(p: StartPayload, e: AgentEntry, detail: string): Promise<RunnerOutcome> {
    const base: CommandResultData = { claudeSessionId: e.claudeSessionId, ...(e.shortId ? { shortId: e.shortId } : {}), detail };
    if (!p.remoteControl) return okOutcome(base);
    const rc = await this.confirmStartRc(e, p.name);
    return okOutcome(rc ? { ...base, detail: `${detail}; remote control on`, remoteControl: rc } : { ...base, detail: `${detail}; remote control not confirmed` });
  }

  private async confirmStartRc(e: AgentEntry, name: string | undefined): Promise<RemoteControlResult | null> {
    const read = this.d.bridgeId ?? readBridgeSessionId;
    const deadline = this.now() + (this.d.timeouts?.rcConfirmMs ?? 25_000);
    for (;;) {
      const cur = (await this.findEntry(e.claudeSessionId).catch(() => undefined)) ?? e;
      const id = cur.pid !== undefined ? read(cur.pid) : null;
      if (id) return { enabled: true, name: name ?? null, url: bridgeUrl(id) };
      if (this.now() >= deadline) return null;
      await this.sleep(this.t.pollMs);
    }
  }

  /**
   * tmux sessiyada Remote Control'ni yoqish/o'chirish (3.10). Faqat bo'sh (idle/waiting) sessiya; pane yangidan tekshiriladi;
   * natija pane/sessiya faylidan TASDIQLANadi (taxmin qilinmaydi). bg sessiya uchun yo'q: faqat ochishda `--remote-control`.
   */
  async remoteControl(p: RemoteControlPayload, entry: AgentEntry): Promise<RunnerOutcome> {
    if (entry.kind === 'bg') return fail('remote_control_unsupported', 'Remote Control of a background session can only be set when it is started');
    const fresh = (await this.findEntry(entry.claudeSessionId).catch(() => undefined)) ?? entry;
    if (fresh.status === 'busy') return fail('session_busy', 'The session is working; wait until it is idle before toggling Remote Control');
    if (this.d.localStatus?.(fresh.claudeSessionId) === 'awaiting_approval') return fail('session_busy', 'The session is waiting for a permission decision');
    const name = safeRcName(p.name);
    if (name === null) return fail('invalid_payload', 'The Remote Control name has unsafe characters');
    const v = await this.verifiedPane(fresh);
    if ('out' in v) return v.out;
    const tmux = this.d.tmux!;
    const state = this.d.bridgeState ?? ((p2: number): BridgeState => (this.d.bridgeId ? { known: true, id: this.d.bridgeId(p2) } : readBridgeState(p2)));
    const pid = fresh.pid;
    try {
      const out = await toggleRemoteControl(
        {
          capture: (t) => tmux.capture(t),
          run: (t, steps, between) => tmux.run(t, steps, this.sleep, between),
          bridge: () => (pid !== undefined ? state(pid) : { known: false, id: null }),
          sleep: this.sleep,
          now: this.now,
          pollMs: this.t.pollMs,
        },
        v.target,
        p.enable,
        p.enable ? name : undefined,
      );
      return out.ok ? okOutcome({ claudeSessionId: p.claudeSessionId, ...(out.detail ? { detail: out.detail } : {}), ...(out.result ? { remoteControl: out.result } : {}) }) : fail(out.code ?? 'remote_control_failed', out.message ?? 'Remote Control toggle failed');
    } catch (err) {
      return fail('remote_control_failed', `tmux failed (${errMsg(err)})`);
    }
  }

  /** Fon sessiyani to'xtatadi va jarayon yo'qolguncha kutadi (aks holda keyingi `--resume` nusxa ochadi). */
  private async stopAndWait(entry: AgentEntry): Promise<RunnerOutcome | null> {
    if (!entry.shortId) return fail('session_not_found', 'The session has no background id');
    if (entry.pid !== undefined) {
      try {
        await this.exec(buildStopArgs(entry.shortId), { timeoutMs: 15_000 });
      } catch (err) {
        // "No job matching" ham exit 1: sessiya allaqachon to'xtagan bo'lishi mumkin; pid holatiga qaraymiz.
        this.d.log.warn('claude stop returned an error; verifying by listing', { error: describeExecError(err) });
      }
    }
    const deadline = this.now() + this.t.stopWaitMs;
    for (;;) {
      let cur: AgentEntry | undefined;
      try {
        cur = await this.findEntry(entry.claudeSessionId);
      } catch {
        cur = entry;
      }
      if (!cur || cur.pid === undefined) return null;
      if (this.now() >= deadline) return fail('stop_failed', 'The session did not stop in time');
      await this.sleep(this.t.pollMs);
    }
  }

  /** Terminal sessiyada tmux pane bormi (siyosat qarori uchun; keshlangan, yuborishdan oldin qayta tekshiriladi). */
  async hasTmuxPane(entry: AgentEntry): Promise<boolean> {
    if (entry.kind !== 'interactive' || entry.pid === undefined || !this.d.tmux) return false;
    return (await this.d.tmux.locate(entry.pid)).ok;
  }

  /** Yuborishdan OLDIN yangi tekshiruv; xato sababi RunnerOutcome sifatida. */
  private async verifiedPane(entry: AgentEntry): Promise<{ target: TmuxTarget } | { out: RunnerOutcome }> {
    if (this.platform === 'win32' || !this.d.tmux) return { out: fail('interactive_session', 'Terminal sessions are view-only (not running inside tmux)') };
    if (entry.pid === undefined) return { out: fail('not_owned', 'The terminal session has no pid') };
    const m: TmuxMatch = await this.d.tmux.locate(entry.pid, { fresh: true });
    if (m.ok) return { target: m.target };
    if (m.reason === 'no_pane') return { out: fail('interactive_session', 'Terminal sessions are view-only (not running inside tmux)') };
    if (m.reason === 'not_owned') return { out: fail('not_owned', 'The tmux pane is not owned by the agentd user') };
    return { out: fail('not_owned', 'The pane foreground process is not this Claude session (the user may have switched to a shell)') };
  }

  /** tmux orqali prompt: faqat bo'sh (idle/waiting) sessiyaga; bracketed paste + bitta Enter. Matn logga/xatoga yozilmaydi. */
  private async promptViaTmux(p: PromptPayload, entry: AgentEntry): Promise<RunnerOutcome> {
    const fresh = (await this.findEntry(entry.claudeSessionId).catch(() => undefined)) ?? entry;
    if (fresh.status !== 'idle' && fresh.status !== 'waiting') return fail('session_busy', 'The session is working; wait until it is idle (or stop it) before sending a prompt');
    if (this.d.localStatus?.(fresh.claudeSessionId) === 'awaiting_approval') return fail('session_busy', 'The session is waiting for a permission decision');
    const text = sanitizePromptText(p.text);
    if (text === null) return fail('invalid_payload', 'The prompt is empty after sanitizing');
    const modeErr = checkPromptModeChar(text);
    if (modeErr) return fail('invalid_payload', modeErr);
    if (text.length > TMUX_PROMPT_MAX) return fail('invalid_payload', 'The prompt is too long');
    const v = await this.verifiedPane(fresh);
    if ('out' in v) return v.out;
    try {
      await this.d.tmux!.run(v.target, planPromptSteps(v.target.paneId, text, newBufferName()), this.sleep);
    } catch (err) {
      return fail('internal', `tmux send failed (${errMsg(err)})`);
    }
    return okOutcome({ claudeSessionId: p.claudeSessionId, detail: 'tmux paste' });
  }

  /** tmux orqali stop: `Escape` (joriy turnni to'xtatadi, sessiyadan CHIQMAYDI). Faqat ish ketayotganda yuboriladi. */
  private async interruptViaTmux(p: StopPayload, entry: AgentEntry, target: TmuxTarget): Promise<RunnerOutcome> {
    const fresh = (await this.findEntry(entry.claudeSessionId).catch(() => undefined)) ?? entry;
    if (fresh.status !== 'busy') return okOutcome({ claudeSessionId: p.claudeSessionId, detail: 'no turn in progress (nothing sent)' });
    try {
      await this.d.tmux!.run(target, planInterruptSteps(target.paneId), this.sleep);
    } catch (err) {
      return fail('stop_failed', `tmux send failed (${errMsg(err)})`);
    }
    return okOutcome({ claudeSessionId: p.claudeSessionId, detail: 'tmux Escape (interrupt turn)' });
  }

  async prompt(p: PromptPayload, entry: AgentEntry): Promise<RunnerOutcome> {
    // M-19: `--resume <id> -- <text>` da `!` bash rejimiga aylanmaydi (argv, TUI tugmasi emas), lekin `/slash` boshlang'ich prompt'da
    // bajarilishi mumkin: ikkala yo'lda ham (tmux va bg) bir xil, erta rad etiladi.
    const modeErr = checkPromptModeChar(sanitizePromptText(p.text) ?? p.text);
    if (modeErr) return fail('invalid_payload', modeErr);
    if (entry.kind !== 'bg') return entry.kind === 'interactive' ? this.promptViaTmux(p, entry) : fail('interactive_session', 'Terminal sessions are view-only (not started with --bg)');
    if (!entry.cwd) return fail('cwd_invalid', 'The session has no cwd');
    if (entry.status === 'busy') return fail('session_busy', 'The session is working; stop it first or wait until it is idle');
    const stopped = await this.stopAndWait(entry);
    if (stopped) return stopped;
    // Supervisor worker'ni qo'yib yuborguncha kutamiz (aks holda `--resume` NUSXA ochadi), keyin qisqa zaxira
    const holds = this.d.supervisorHolds ?? defaultSupervisorHolds;
    if (entry.shortId) {
      const until = this.now() + this.t.stopWaitMs;
      while (holds(entry.shortId)) {
        if (this.now() >= until) return fail('stop_failed', 'Claude still holds the stopped session; try again shortly');
        await this.sleep(this.t.pollMs);
      }
    }
    await this.sleep(this.t.resumeSettleMs);

    let stdout: string;
    try {
      stdout = await this.exec(buildResumeArgs(p.claudeSessionId, p.text), { cwd: entry.cwd, timeoutMs: this.t.startMs });
    } catch (err) {
      const why = describeExecError(err);
      return why === 'shim' ? fail('shim_unsupported', 'Windows .cmd shims cannot pass free text safely; install the native claude.exe') : fail('claude_failed', `claude --resume failed (${why})`);
    }
    const { shortId, copyOf } = parseBackgrounded(stdout);
    if (copyOf || (shortId && entry.shortId && shortId !== entry.shortId)) {
      // Nusxa ochildi (bu sessiya davom etmadi): nusxani to'xtatamiz va xato beramiz (chalkash ikkilangan sessiya qolmasin).
      const copy = copyOf ?? shortId;
      if (copy) await this.exec(buildStopArgs(copy), { timeoutMs: 15_000 }).catch(() => undefined);
      return fail('resume_forked', 'Claude started a copy instead of continuing the session; the copy was stopped');
    }
    return okOutcome({ claudeSessionId: p.claudeSessionId, ...(entry.shortId ? { shortId: entry.shortId } : {}), detail: 'stop+resume' });
  }

  async stop(p: StopPayload, entry: AgentEntry): Promise<RunnerOutcome> {
    if (entry.kind === 'bg') {
      const err = await this.stopAndWait(entry);
      return err ?? okOutcome({ claudeSessionId: p.claudeSessionId, ...(entry.shortId ? { shortId: entry.shortId } : {}), detail: 'claude stop' });
    }
    // tmux ichida bo'lsa: Escape (turnni to'xtatish). Pane topilmasa — eski yo'l (SIGINT).
    if (this.d.tmux && this.platform !== 'win32' && entry.kind === 'interactive') {
      const v = await this.verifiedPane(entry);
      if ('target' in v) return this.interruptViaTmux(p, entry, v.target);
      if (v.out.code === 'not_owned') return v.out;
    }
    return this.interruptInteractive(p, entry);
  }

  /** Terminal sessiya: SIGINT (Ctrl-C ekvivalenti; joriy ishni to'xtatadi). Faqat POSIX va jarayon egasi/buyrug'i tekshirilgandan keyin. */
  private async interruptInteractive(p: StopPayload, entry: AgentEntry): Promise<RunnerOutcome> {
    if (this.platform === 'win32') return fail('interactive_session', 'Terminal sessions cannot be interrupted on Windows');
    if (entry.pid === undefined) return fail('not_owned', 'The terminal session has no pid');
    const uid = this.d.uid ?? (typeof process.getuid === 'function' ? process.getuid() : undefined);
    const info = await (this.d.procInfo ?? defaultProcInfo)(entry.pid);
    if (!info || uid === undefined || info.uid !== uid) return fail('not_owned', 'The process is not owned by the agentd user');
    if (!/(^|[\\/\s])claude(\s|$)|claude-code/i.test(info.command)) return fail('not_owned', 'The pid does not look like a Claude Code process');
    try {
      (this.d.signal ?? ((pid, sig) => process.kill(pid, sig)))(entry.pid, 'SIGINT');
    } catch (err) {
      return fail('stop_failed', `SIGINT failed (${errMsg(err)})`);
    }
    return okOutcome({ claudeSessionId: p.claudeSessionId, detail: 'SIGINT (interrupt)' });
  }

  /** Boshqariladigan sessiyada rejimni o'zgartirib bo'lmaydi: bayroq NUSXA ochadi (spike). */
  setMode(_p: SetModePayload): RunnerOutcome {
    return fail('set_mode_unsupported', 'Claude Code cannot change a background session\'s permission mode in place (flags fork a copy)');
  }
}
