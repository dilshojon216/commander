import { randomUUID } from 'node:crypto';
import { COMMAND_LIMITS } from '@commander/contracts';
import type { MachineDto, RemotePermissionMode } from '@commander/contracts';
import { agentNotReadyReason } from '../commands/control-logic.js';

/**
 * `/new` (Telegram'dan masofaviy sessiya ochish) uchun sof mantiq: suhbat holati (xotirada, 10 daqiqa), tugma havolalari
 * (callback_data ichida hech qanday qiymat yo'q: faqat imzolangan ref, qiymat serverda), tezlik chegarasi, tekshiruvlar.
 * IO yo'q: `TelegramService` shuni ishlatadi, vaqt tashqaridan beriladi (testlanadi).
 */

export const FLOW_TTL_MS = 10 * 60_000;
/** Progress/stop tugmalari uzoqroq yashaydi (sessiya bir necha daqiqa ishlashi mumkin). */
export const TARGET_TTL_MS = 60 * 60_000;
export const NEW_RATE_MAX = 5;
export const NEW_RATE_WINDOW_MS = 10 * 60_000;
export const MAX_FOLDERS = 10;
const MAX_REFS_PER_CHAT = 300;

export const MODELS: ReadonlyArray<{ alias: string; label: string }> = [
  { alias: 'haiku', label: 'Haiku' },
  { alias: 'sonnet', label: 'Sonnet' },
  { alias: 'opus', label: 'Opus' },
];

export const MODE_LABELS: Record<RemotePermissionMode, string> = {
  default: 'Qo\'lda',
  acceptEdits: 'Avto tahrir',
  plan: 'Reja',
  auto: 'Avto (auto)',
};

/** Tanlash mumkin bo'lgan rejimlar: `auto` faqat mashina siyosati `allowAutoMode` ni yoqqan bo'lsa. */
export function availableModes(allowAuto: boolean): RemotePermissionMode[] {
  const modes: RemotePermissionMode[] = ['default', 'acceptEdits', 'plan'];
  if (allowAuto) modes.push('auto');
  return modes;
}

/** `/new` ro'yxatida ko'rinadigan mashina: online, siyosat yoqilgan va tayyor, start ruxsat etilgan. */
export function isStartable(m: Pick<MachineDto, 'online' | 'control'>): boolean {
  return m.online && m.control !== null && agentNotReadyReason(m.control) === null && m.control.allowStart;
}

export type FlowStage = 'machine' | 'folder' | 'path' | 'model' | 'mode' | 'task' | 'summary' | 'auto_confirm' | 'submitted';

export interface Flow {
  id: string;
  chatId: string;
  stage: FlowStage;
  machineId: string | null;
  machineName: string | null;
  allowAuto: boolean;
  cwd: string | null;
  model: string | null;
  mode: RemotePermissionMode | null;
  /** Vazifa matni: faqat xotirada, yuborilgach o'chiriladi. */
  text: string | null;
  /** Hozir tahrirlanadigan karta xabari. */
  cardMessageId: number | null;
  /** 3.1: yakuniy variant navbat bo'lsa (`auto` uchun qo'shimcha tasdiqdan keyin yuboriladi). */
  queue: 'reset' | 'night' | null;
  /** 6.9: tanlangan shablon "katta vazifa" (avto-checkpoint, sozlama yoqilgan bo'lsa). */
  bigTask?: boolean;
  touchedAt: number;
}

export class FlowStore {
  private readonly flows = new Map<string, Flow>();
  private readonly expired = new Set<string>();

  constructor(private readonly ttlMs: number = FLOW_TTL_MS) {}

  start(chatId: string, now: number): Flow {
    const flow: Flow = {
      id: randomUUID(),
      chatId,
      stage: 'machine',
      machineId: null,
      machineName: null,
      allowAuto: false,
      cwd: null,
      model: null,
      mode: null,
      text: null,
      cardMessageId: null,
      queue: null,
      touchedAt: now,
    };
    this.flows.set(chatId, flow);
    this.expired.delete(chatId);
    return flow;
  }

  /** Muddati o'tgan bo'lsa `null` (va keyingi `consumeExpired` bir marta `true`). Faol bo'lsa `touchedAt` yangilanadi. */
  get(chatId: string, now: number): Flow | null {
    const f = this.flows.get(chatId);
    if (!f) return null;
    if (now - f.touchedAt > this.ttlMs) {
      this.flows.delete(chatId);
      this.expired.add(chatId);
      return null;
    }
    f.touchedAt = now;
    return f;
  }

  clear(chatId: string): void {
    this.flows.delete(chatId);
  }

  consumeExpired(chatId: string): boolean {
    return this.expired.delete(chatId);
  }
}

/** Tugma qiymatlari. Qiymat HECH QACHON callback_data ichida emas: imzolangan ref -> shu yerdagi yozuv. */
export interface ReplyTarget {
  sessionId: string | null;
  commandId: string | null;
}
export type PickValue =
  | { kind: 'machine'; machineId: string }
  | { kind: 'folder'; cwd: string }
  | { kind: 'other_folder' }
  | { kind: 'model'; model: string }
  | { kind: 'mode'; mode: RemotePermissionMode }
  | { kind: 'go' }
  | { kind: 'go_auto' }
  /** 3.1: navbat: limit yangilanganda / tunda (02:00 Toshkent) ochish; `queue_cancel`: /queue ro'yxatidagi bekor tugmasi. */
  | { kind: 'queue_reset' }
  | { kind: 'queue_night' }
  | { kind: 'queue_cancel'; id: string }
  /** 3.4: `/new` vazifa bosqichida "Shablondan": ro'yxat, tanlash, orqaga. */
  | { kind: 'tpl_list' }
  | { kind: 'tpl_pick'; templateId: string }
  | { kind: 'tpl_back' }
  /** 3.10: /s kartasidagi Remote Control: yoqishdan oldin tasdiq (`rc_ask`), tasdiq/bajarish (`rc_go`), orqaga (`rc_no`). */
  | { kind: 'rc_ask'; target: ReplyTarget }
  | { kind: 'rc_go'; target: ReplyTarget; enable: boolean }
  | { kind: 'rc_no'; target: ReplyTarget }
  /** 6.14: tugagan terminal sessiyani tmux'da davom ettirish (`resume_*`) va tmux sessiyani yopish (`close_*`): karta -> tasdiq -> bekor. */
  | { kind: 'resume_ask'; target: ReplyTarget }
  | { kind: 'resume_go'; target: ReplyTarget }
  | { kind: 'resume_no'; target: ReplyTarget }
  | { kind: 'close_ask'; target: ReplyTarget }
  | { kind: 'close_go'; target: ReplyTarget }
  | { kind: 'close_no'; target: ReplyTarget }
  | { kind: 'back' }
  | { kind: 'cancel' }
  | { kind: 'stop_ask'; target: ReplyTarget }
  | { kind: 'stop_yes'; target: ReplyTarget }
  | { kind: 'stop_no'; target: ReplyTarget }
  /** 3.5: sessiya tugagach "📄 Diff" (faqat statistika) va "🔀 PR ochish" (karta -> `git_pr_yes` = chat ichidagi tasdiq). */
  | { kind: 'git_diff'; sessionId: string }
  | { kind: 'git_pr'; sessionId: string }
  | { kind: 'git_pr_yes'; sessionId: string }
  | { kind: 'git_pr_no' }
  /** 6.4: hodisa xabaridagi "🔍 Claude tekshirsin": karta (`inv_ask`) -> chat ichidagi tasdiq (`inv_go`) / bekor (`inv_no`). */
  | { kind: 'inv_ask'; subject: 'health' | 'watchdog'; id: string }
  | { kind: 'inv_go'; subject: 'health' | 'watchdog'; id: string }
  | { kind: 'inv_no' }
  /** 6.5: deploy xabaridagi "↩️ Rollback": karta (`deploy_rb_ask`) -> chat ichidagi tasdiq (`deploy_rb_yes`) / bekor (`deploy_rb_no`). */
  | { kind: 'deploy_rb_ask'; commandId: string }
  | { kind: 'deploy_rb_yes'; commandId: string }
  | { kind: 'deploy_rb_no' };

interface RefEntry {
  value: PickValue;
  /** `/new` tugmalari uchun suhbat id'si (boshqa/eskirgan suhbat tugmasi ishlamaydi); stop tugmalari uchun `null`. */
  flowId: string | null;
  expiresAt: number;
}

export class PickRegistry {
  private readonly perChat = new Map<string, Map<string, RefEntry>>();

  issue(chatId: string, value: PickValue, flowId: string | null, now: number, ttlMs: number): string {
    const ref = randomUUID();
    const map = this.perChat.get(chatId) ?? new Map<string, RefEntry>();
    this.perChat.set(chatId, map);
    map.set(ref, { value, flowId, expiresAt: now + ttlMs });
    if (map.size > MAX_REFS_PER_CHAT) {
      for (const [k, e] of map) if (e.expiresAt <= now) map.delete(k);
      for (const k of map.keys()) {
        if (map.size <= MAX_REFS_PER_CHAT) break;
        map.delete(k); // eng eskilari (Map qo'shilish tartibida)
      }
    }
    return ref;
  }

  resolve(chatId: string, ref: string, now: number): { value: PickValue; flowId: string | null } | null {
    const e = this.perChat.get(chatId)?.get(ref);
    if (!e || e.expiresAt <= now) return null;
    return { value: e.value, flowId: e.flowId };
  }
}

/** /new tezlik chegarasi: chat bo'yicha oynada eng ko'pi bilan `max` ta. */
export class RateGate {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly max: number = NEW_RATE_MAX,
    private readonly windowMs: number = NEW_RATE_WINDOW_MS,
  ) {}

  allow(chatId: string, now: number): boolean {
    const recent = (this.hits.get(chatId) ?? []).filter((t) => now - t < this.windowMs);
    if (recent.length >= this.max) {
      this.hits.set(chatId, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(chatId, recent);
    return true;
  }
}

export type TypedPath = { ok: true; path: string } | { ok: false; reason: 'empty' | 'too_long' | 'not_absolute' | 'bad_chars' };

/** Foydalanuvchi yozgan papka yo'li: mutlaq yo'l bo'lishi shart (POSIX yoki Windows). Siyosatni baribir agentd tekshiradi. */
export function parseTypedPath(raw: string): TypedPath {
  const path = raw.trim();
  if (path === '') return { ok: false, reason: 'empty' };
  if (path.length > COMMAND_LIMITS.cwdMaxChars) return { ok: false, reason: 'too_long' };
  if (/[\u0000-\u001f]/.test(path)) return { ok: false, reason: 'bad_chars' };
  if (!/^(\/|[A-Za-z]:[\\/])/.test(path)) return { ok: false, reason: 'not_absolute' };
  return { ok: true, path };
}

export function validTaskText(raw: string): { ok: true; text: string } | { ok: false; reason: 'empty' | 'too_long' } {
  const text = raw.trim();
  if (text === '') return { ok: false, reason: 'empty' };
  if (Array.from(text).length > COMMAND_LIMITS.promptMaxChars) return { ok: false, reason: 'too_long' };
  return { ok: true, text };
}

/** `/s` argumenti: tartib raqami (1..99) yoki hex prefiks (>= 4 belgi). */
export type SessionArg = { kind: 'index'; n: number } | { kind: 'prefix'; prefix: string } | { kind: 'invalid' };

export function parseSessionArg(raw: string): SessionArg {
  const a = raw.trim().toLowerCase();
  if (/^\d{1,2}$/.test(a) && Number(a) >= 1) return { kind: 'index', n: Number(a) };
  if (/^[0-9a-f-]{4,36}$/.test(a)) return { kind: 'prefix', prefix: a };
  return { kind: 'invalid' };
}

export const lastSegment = (p: string): string => p.split(/[\\/]/).filter(Boolean).pop() ?? p;
