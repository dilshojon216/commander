import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { extractTaskMarker, taskKeyFromBranch } from '@commander/contracts';
import type { AgentEvent } from '@commander/contracts';
import { readHead } from './git-info.js';
import { inTransaction } from './db.js';
import type { Logger } from './logger.js';
import type { Outbox } from './outbox.js';
import type { ProjectRootResolver } from './project-root.js';
import { redact } from './redact.js';
import { MAX_MESSAGE_LEN, MAX_NOTIFICATION_TYPE_LEN, mapHookToStatus, truncate } from './session-state.js';
import type { SessionStore } from './session-store.js';

/** Claude Code hook JSON (stdin). Faqat kerakli maydonlar; qolganlari e'tiborsiz. */
export const HookPayloadSchema = z.looseObject({
  hook_event_name: z.string().min(1).max(64),
  session_id: z.string().min(1).max(255),
  cwd: z.string().min(1).max(4096).nullish(),
  transcript_path: z.string().min(1).max(4096).nullish(),
  message: z.string().nullish(),
  notification_type: z.string().nullish(),
  reason: z.string().nullish(),
  /** Subagent hodisalari sessiyaning o'z holati emas. */
  agent_id: z.string().nullish(),
  /** `default`, `acceptEdits`, `plan`, `bypassPermissions`, ... (markazga ko'rsatish uchun). */
  permission_mode: z.string().nullish(),
  /**
   * UserPromptSubmit: foydalanuvchi prompti. FAQAT vazifa marker'ini (id) ajratish uchun o'qiladi (`extractTaskMarker`);
   * prompt matni hodisaga, outbox'ga, logga yoki DB'ga HECH QACHON tushmaydi (CLAUDE.md qoida 5).
   */
  prompt: z.string().nullish(),
});
export type HookPayload = z.infer<typeof HookPayloadSchema>;

export interface HookProcessorDeps {
  db: DatabaseSync;
  store: SessionStore;
  outbox: Outbox;
  roots: ProjectRootResolver;
  log: Logger;
  now?: () => number;
  /** Yangi transcript yo'li ma'lum bo'lganda (tailer'ga xabar). */
  onTranscript?: (sessionId: string, path: string, fresh: boolean) => void;
  /** Loyiha ildizi aniqlanganda (project-reporter yangi ildizni biladi). */
  onRoot?: (root: string) => void;
  /** Git branch nomi (vazifani branch'dan taxmin qilish). Sukut: `.git/HEAD`ni fayldan o'qish (jarayonsiz). */
  readBranch?: (root: string) => string | null;
  /** Git HEAD sha (3.5: sessiya diff'i bazasi, faqat `SessionStart`da). Sukut: `.git/HEAD`ni fayldan o'qish. */
  readHeadSha?: (root: string) => string | null;
}

const PERMISSION_MODE_RE = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;

/** SubagentStop kelmay qolgan (uzilgan) subagent sessiyani abadiy `working`da ushlab turmasin. */
export const SUBAGENT_TTL_MS = 3 * 60 * 60_000;
const MAX_SUBAGENTS_PER_SESSION = 64;

export class HookProcessor {
  private readonly now: () => number;
  /** Sessiya bo'yicha markazga oxirgi yuborilgan ruxsat rejimi (xotirada; restartdan keyin birinchi hook qayta yuboradi). */
  private readonly lastMode = new Map<string, string>();
  /** Sessiya bo'yicha oxirgi yuborilgan aniq marker (takror yubormaslik). */
  private readonly lastExplicit = new Map<string, string>();
  /** Sessiya bo'yicha oxirgi yuborilgan branch-taxmin (`null` = branch vazifaga mos kelmaydi). */
  private readonly lastBranchTask = new Map<string, string | null>();
  /** Sessiya bo'yicha hali tugamagan subagentlar: agent_id -> boshlangan vaqt (xotirada). */
  private readonly subagents = new Map<string, Map<string, number>>();

  constructor(private readonly d: HookProcessorDeps) {
    this.now = d.now ?? Date.now;
  }

  /** `true` = hodisa outbox'ga qo'yildi. Xato tashlamaydi (hook fail-safe), lekin logga yozadi. */
  process(raw: unknown): boolean {
    const parsed = HookPayloadSchema.safeParse(raw);
    if (!parsed.success) {
      this.d.log.debug('hook payload yaroqsiz, e\'tiborsiz', { issues: parsed.error.issues.length });
      return false;
    }
    const p = parsed.data;
    if (p.agent_id) {
      this.trackSubagent(p.session_id, p.hook_event_name, p.agent_id);
      return false; // subagent hodisasi sessiyaning o'z holati emas
    }

    const { store, outbox, roots } = this.d;
    const existing = store.get(p.session_id);
    const root = p.cwd ? roots.resolve(p.cwd) : undefined;
    if (root) this.d.onRoot?.(root);
    store.touchFromHook(p.session_id, {
      ...(p.cwd ? { cwd: p.cwd } : {}),
      ...(root ? { root } : {}),
      transcriptPath: p.transcript_path ?? null,
    });
    if (p.transcript_path && p.transcript_path !== existing?.transcriptPath) {
      this.d.onTranscript?.(p.session_id, p.transcript_path, p.hook_event_name === 'SessionStart');
    }

    const mode = p.permission_mode && PERMISSION_MODE_RE.test(p.permission_mode) ? p.permission_mode : undefined;
    let status = mapHookToStatus({
      event: p.hook_event_name,
      notificationType: p.notification_type ?? null,
      last: existing?.status ?? undefined,
      backgroundAgents: this.activeSubagents(p.session_id),
    });
    const task = this.detectTask(p, root ?? existing?.root ?? existing?.cwd ?? null);
    if (status === null) {
      // Holat o'zgarmadi, lekin ruxsat rejimi o'zgargan (Shift+Tab) yoki vazifa marker'i o'zgargan:
      // joriy holat bilan yangilash hodisasi yuboriladi
      const current = existing?.status;
      const live = current && current !== 'ended' ? current : undefined;
      if (live && ((mode && this.lastMode.get(p.session_id) !== mode) || task)) status = live;
      else if (task && p.hook_event_name === 'UserPromptSubmit') status = 'working';
      else return false;
    }
    if (mode) this.lastMode.set(p.session_id, mode);
    if (status === 'ended') this.lastMode.delete(p.session_id);

    const row = store.get(p.session_id);
    const event: AgentEvent = {
      eventId: randomUUID(),
      claudeSessionId: p.session_id,
      event: p.hook_event_name,
      status,
      cwd: root ?? row?.root ?? row?.cwd ?? '/unknown',
      ...(p.cwd ? { rootKind: roots.kind(p.cwd) } : {}),
      ts: this.now(),
      ...(mode ? { permissionMode: mode } : {}),
      ...(task ? { taskKey: task.key, taskSource: task.source } : {}),
      ...this.startHead(p.hook_event_name, root ?? row?.root ?? row?.cwd ?? null),
      ...optional('message', truncate(p.message ? redact(p.message) : undefined, MAX_MESSAGE_LEN)),
      ...optional('notificationType', truncate(p.notification_type, MAX_NOTIFICATION_TYPE_LEN)),
      ...optional('transcriptPath', p.transcript_path ?? row?.transcriptPath ?? undefined),
      ...(status === 'ended' ? optional('reason', truncate(p.reason, 64)) : {}),
    };
    inTransaction(this.d.db, () => {
      outbox.enqueueEvent(event);
      store.setStatus(p.session_id, status);
    });
    if (task) this.rememberTask(p.session_id, task);
    if (status === 'ended') this.forgetSession(p.session_id);
    return true;
  }

  private trackSubagent(sessionId: string, event: string, agentId: string): void {
    if (event === 'SubagentStart') {
      const set = this.subagents.get(sessionId) ?? new Map<string, number>();
      if (set.size >= MAX_SUBAGENTS_PER_SESSION && !set.has(agentId)) return;
      set.set(agentId, this.now());
      this.subagents.set(sessionId, set);
    } else if (event === 'SubagentStop') {
      const set = this.subagents.get(sessionId);
      set?.delete(agentId);
      if (set?.size === 0) this.subagents.delete(sessionId);
    }
  }

  private activeSubagents(sessionId: string): number {
    const set = this.subagents.get(sessionId);
    if (!set) return 0;
    const cutoff = this.now() - SUBAGENT_TTL_MS;
    for (const [id, startedAt] of set) if (startedAt < cutoff) set.delete(id);
    if (set.size === 0) this.subagents.delete(sessionId);
    return set.size;
  }

  /**
   * Vazifa marker'i (task 2.9): aniq (`/task <id>`, `#task:<id>`) birinchi; aks holda branch nomidan taxmin. Faqat O'ZGARISHDA
   * qaytadi (takror yuborilmaydi). Natijada faqat id (prompt matni emas). `key: null` + `branch` = branch endi vazifa emas.
   */
  private detectTask(p: HookPayload, root: string | null): TaskMarker | null {
    const event = p.hook_event_name;
    if (event !== 'UserPromptSubmit' && event !== 'SessionStart') return null;
    const sid = p.session_id;
    if (event === 'UserPromptSubmit') {
      const explicit = extractTaskMarker(p.prompt);
      if (explicit) return this.lastExplicit.get(sid) === explicit ? null : { key: explicit, source: 'explicit' };
    }
    if (this.lastExplicit.has(sid)) return null; // aniq marker faol: branch taxmini kerak emas (markaz ham e'tiborsiz qoldiradi)
    if (!root) return null;
    const branch = (this.d.readBranch ?? defaultReadBranch)(root);
    const key = taskKeyFromBranch(branch);
    const last = this.lastBranchTask.get(sid);
    if (last === undefined && key === null) {
      this.lastBranchTask.set(sid, null);
      return null; // yopiladigan narsa yo'q
    }
    return key === (last ?? null) ? null : { key, source: 'branch' };
  }

  /** `SessionStart`: git HEAD sha (3.5). Git yo'q/o'qib bo'lmasa bo'sh. */
  private startHead(event: string, root: string | null): { headSha?: string } {
    if (event !== 'SessionStart' || !root) return {};
    const sha = (this.d.readHeadSha ?? defaultReadHeadSha)(root);
    return sha ? { headSha: sha } : {};
  }

  private rememberTask(sid: string, t: TaskMarker): void {
    if (t.source === 'explicit' && t.key) this.lastExplicit.set(sid, t.key);
    else if (t.source === 'branch') this.lastBranchTask.set(sid, t.key);
  }

  private forgetSession(sid: string): void {
    this.lastExplicit.delete(sid);
    this.lastBranchTask.delete(sid);
    this.subagents.delete(sid);
  }
}

interface TaskMarker {
  key: string | null;
  source: 'explicit' | 'branch';
}

function defaultReadBranch(root: string): string | null {
  return readHead(root)?.branch ?? null;
}

function defaultReadHeadSha(root: string): string | null {
  return readHead(root)?.sha ?? null;
}

function optional<K extends string>(key: K, value: string | undefined): Partial<Record<K, string>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, string>);
}
