import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { AuditService } from '../identity/audit/audit.service.js';
import { isChatId, parseChatIds } from './chat-ids.js';

export const KEY_ALLOWED = 'telegram.allowed_chat_ids';
export const KEY_PENDING = 'telegram.pending';
export const KEY_PREFS = 'telegram.prefs';

/** /start yuborgan, lekin allowlist'da yo'q chat. Qisqa muddat saqlanadi. */
export interface PendingChat {
  chatId: string;
  username: string | null;
  name: string | null;
  at: number;
}

export interface TelegramPrefs {
  notifyDone: boolean;
  /** epoch ms, 0 = mute yo'q. */
  mutedUntil: number;
  /** `decideLimitAlerts` holati. */
  limitAlerts: Record<string, number>;
  /** 3.1: `decideForecastAlert` holati (oyna uchun bir marta). */
  forecastAlerts?: Record<string, number>;
}

export const DEFAULT_PREFS: TelegramPrefs = { notifyDone: true, mutedUntil: 0, limitAlerts: {} };

export const PENDING_TTL_MS = 60 * 60_000;
export const PENDING_MAX = 10;
const ALLOW_CACHE_MS = 5_000;
const PENDING_MIN_GAP_MS = 30_000;

/**
 * Telegram allowlist, pairing (pending) va sozlamalar. Barchasi `settings` jadvalida: bot (center jarayoni) va
 * admin CLI (boshqa jarayon) bir xil holatni ko'radi. Allowlist = env (`TELEGRAM_ALLOWED_CHAT_IDS`) UNION DB.
 * Hech kim avtomatik allowlist'ga tushmaydi: faqat CLI `telegram allow <id>` (audit qilinadi).
 */
@Injectable()
export class TelegramAccessService {
  private cache: { at: number; ids: Set<string> } | null = null;
  private readonly lastPendingAt = new Map<string, number>();
  private pendingChain: Promise<unknown> = Promise.resolve();

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
  ) {}

  envIds(): string[] {
    try {
      return parseChatIds(this.config.get<string>('TELEGRAM_ALLOWED_CHAT_IDS'));
    } catch {
      return []; // validateEnv startda allaqachon rad etgan; bu yerda jim va xavfsiz tomonga
    }
  }

  async dbIds(): Promise<string[]> {
    const v = await this.getSetting<{ ids?: unknown }>(KEY_ALLOWED);
    return Array.isArray(v?.ids) ? v.ids.filter((x): x is string => typeof x === 'string' && isChatId(x)) : [];
  }

  /** env + DB (5 s kesh; CLI'da `allow` bo'lsa bot ko'pi bilan 5 s da ko'radi). */
  async allowedIds(now: number = Date.now()): Promise<Set<string>> {
    if (this.cache && now - this.cache.at < ALLOW_CACHE_MS) return this.cache.ids;
    const ids = new Set<string>([...this.envIds(), ...(await this.dbIds())]);
    this.cache = { at: now, ids };
    return ids;
  }

  async isAllowed(chatId: number | string): Promise<boolean> {
    return (await this.allowedIds()).has(String(chatId));
  }

  /** Allowlist'ga qo'shadi, `telegram` identity qurilmasini yaratadi/tiklaydi, audit yozadi (bitta tranzaksiya). */
  async allow(chatId: string, via: string): Promise<{ added: boolean; deviceId: string }> {
    if (!isChatId(chatId)) throw new Error('chat id must be a positive integer');
    const result = await this.dataSource.transaction(async (m) => {
      const cur = await this.getSetting<{ ids?: string[] }>(KEY_ALLOWED, m);
      const ids = Array.isArray(cur?.ids) ? cur.ids : [];
      const added = !ids.includes(chatId);
      if (added) await this.setSetting(KEY_ALLOWED, { ids: [...ids, chatId] }, m);
      const deviceId = await this.upsertDevice(chatId, true, m);
      await this.audit.record({ actorDeviceId: null, actorKind: 'system', action: 'telegram.chat_allowed', target: chatId, details: { chat_id: chatId, via, added } }, m);
      return { added, deviceId };
    });
    this.cache = null;
    return result;
  }

  /** DB allowlist'dan olib tashlaydi va qurilmani revoke qiladi (env'dagi id'ni env'dan olib tashlash kerak). */
  async remove(chatId: string, via: string): Promise<{ removed: boolean; stillInEnv: boolean }> {
    const removed = await this.dataSource.transaction(async (m) => {
      const cur = await this.getSetting<{ ids?: string[] }>(KEY_ALLOWED, m);
      const ids = Array.isArray(cur?.ids) ? cur.ids : [];
      const had = ids.includes(chatId);
      if (had) await this.setSetting(KEY_ALLOWED, { ids: ids.filter((x) => x !== chatId) }, m);
      await m.query(`UPDATE devices SET revoked_at = now() WHERE kind = 'telegram' AND external_id = $1 AND revoked_at IS NULL`, [chatId]);
      await this.audit.record({ actorKind: 'system', action: 'telegram.chat_removed', target: chatId, details: { chat_id: chatId, via, was_in_db: had } }, m);
      return had;
    });
    this.cache = null;
    return { removed, stillInEnv: this.envIds().includes(chatId) };
  }

  /** Bot qaror berganda kimlik: faol (revoke qilinmagan) `telegram` qurilmasi; yo'q bo'lsa yaratadi. Revoke bo'lsa null. */
  async deviceFor(chatId: string): Promise<string | null> {
    const rows: Array<{ id: string; revoked_at: Date | null }> = await this.dataSource.query(`SELECT id, revoked_at FROM devices WHERE kind = 'telegram' AND external_id = $1`, [chatId]);
    const row = rows[0];
    if (row) return row.revoked_at ? null : row.id;
    return this.upsertDevice(chatId, false);
  }

  private async upsertDevice(chatId: string, unrevoke: boolean, manager?: DataSource['manager']): Promise<string> {
    const run = manager ?? this.dataSource.manager;
    const rows: Array<{ id: string }> = await run.query(
      `INSERT INTO devices (kind, name, external_id, scopes) VALUES ('telegram', $1, $2, ARRAY['read','approve']::text[])
       ON CONFLICT (kind, external_id) DO UPDATE SET revoked_at = CASE WHEN $3::boolean THEN NULL ELSE devices.revoked_at END
       RETURNING id`,
      [`telegram:${chatId}`, chatId, unrevoke],
    );
    return rows[0]!.id;
  }

  // --- pairing ------------------------------------------------------------------------------

  /** Allowlist'da bo'lmagan /start yuboruvchini eslab qoladi (jim; ko'pi bilan 10 ta, 1 soat). Hech kimni allow qilmaydi. */
  async recordPending(chat: { chatId: string; username?: string | null; name?: string | null }, now: number = Date.now()): Promise<void> {
    const last = this.lastPendingAt.get(chat.chatId);
    if (last !== undefined && now - last < PENDING_MIN_GAP_MS) return;
    this.lastPendingAt.set(chat.chatId, now);
    if (this.lastPendingAt.size > 500) this.lastPendingAt.clear();
    const task = this.pendingChain.then(async () => {
      const live = (await this.listPending(now)).filter((p) => p.chatId !== chat.chatId);
      const entry: PendingChat = { chatId: chat.chatId, username: chat.username ?? null, name: chat.name ?? null, at: now };
      await this.setSetting(KEY_PENDING, { items: [entry, ...live].slice(0, PENDING_MAX) });
    });
    this.pendingChain = task.catch(() => undefined);
    await task;
  }

  async listPending(now: number = Date.now()): Promise<PendingChat[]> {
    const v = await this.getSetting<{ items?: unknown }>(KEY_PENDING);
    const items = Array.isArray(v?.items) ? v.items : [];
    const allowed = await this.allowedIds(now);
    return items
      .filter((p): p is PendingChat => !!p && typeof p === 'object' && typeof (p as PendingChat).chatId === 'string' && typeof (p as PendingChat).at === 'number')
      .filter((p) => now - p.at < PENDING_TTL_MS && !allowed.has(p.chatId));
  }

  // --- sozlamalar ---------------------------------------------------------------------------

  async loadPrefs(): Promise<TelegramPrefs> {
    const v = await this.getSetting<Partial<TelegramPrefs>>(KEY_PREFS);
    return {
      notifyDone: v?.notifyDone !== false,
      mutedUntil: typeof v?.mutedUntil === 'number' ? v.mutedUntil : 0,
      limitAlerts: v?.limitAlerts && typeof v.limitAlerts === 'object' ? { ...v.limitAlerts } : {},
      forecastAlerts: v?.forecastAlerts && typeof v.forecastAlerts === 'object' ? { ...v.forecastAlerts } : {},
    };
  }

  async savePrefs(p: TelegramPrefs): Promise<void> {
    await this.setSetting(KEY_PREFS, { ...p });
  }

  // --- settings jadvali ---------------------------------------------------------------------

  private async getSetting<T>(key: string, manager?: DataSource['manager']): Promise<T | undefined> {
    const rows: Array<{ value: T }> = await (manager ?? this.dataSource.manager).query(`SELECT value FROM settings WHERE key = $1`, [key]);
    return rows[0]?.value;
  }

  private async setSetting(key: string, value: unknown, manager?: DataSource['manager']): Promise<void> {
    await (manager ?? this.dataSource.manager).query(
      `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2::jsonb, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [key, JSON.stringify(value)],
    );
  }
}
