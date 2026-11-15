import { Bot } from 'grammy';
import type { Update } from 'grammy/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StepUpRegistry } from '../commands/step-up.js';
import { RealtimeBus } from '../realtime/realtime-bus.js';
import { telegramExtensions } from '../telegram/telegram-extensions.js';
import { TelegramService } from '../telegram/telegram.service.js';
import type { TelegramOptions } from '../telegram/telegram.options.js';

const TOKEN = '123456:FAKE-token-used-in-unit-tests-only';
const OWNER = 4242;
const STRANGER = 9999;

interface ApiCall {
  method: string;
  payload: Record<string, unknown>;
}

/** Soxta Telegram API (tarmoq yo'q): watchdog/hisobot yuborish va /report buyrug'i. */
function setup() {
  const calls: ApiCall[] = [];
  const bot = new Bot(TOKEN, { botInfo: { id: 1, is_bot: true, first_name: 'C', username: 'c_bot', can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false, has_topics_enabled: false, allows_users_to_create_topics: false } as never });
  let id = 1;
  bot.api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload: payload as Record<string, unknown> });
    if (method === 'sendMessage') return { ok: true, result: { message_id: id++, date: 0, chat: { id: (payload as { chat_id: number }).chat_id, type: 'private' } } } as never;
    return { ok: true, result: true } as never;
  });
  const allowed = new Set([String(OWNER)]);
  const access = {
    allowedIds: vi.fn(async () => allowed),
    isAllowed: vi.fn(async (x: number | string) => allowed.has(String(x))),
    deviceFor: vi.fn(async () => 'dev'),
    recordPending: vi.fn(async () => undefined),
    loadPrefs: vi.fn(async () => ({ notifyDone: true, mutedUntil: 0, limitAlerts: {} })),
    savePrefs: vi.fn(async () => undefined),
  };
  const options: TelegramOptions = { token: TOKEN, polling: false, machineOfflineAfterMs: 120_000, machineGraceMs: 0, machineTickMs: 3_600_000, sessionMinGapMs: 60_000 };
  const service = new TelegramService(
    options,
    bot,
    access as never,
    {} as never,
    { list: vi.fn(async () => ({ items: [], onlineCount: 0 })) } as never,
    { list: vi.fn(async () => ({ items: [], nextCursor: null })) } as never,
    {} as never,
    { current: vi.fn() } as never,
    { state: vi.fn(async () => ({ enabled: false, since: null })) } as never,
    { record: vi.fn(async () => undefined) } as never,
    new RealtimeBus(),
    {} as never,
    new StepUpRegistry(),
    {} as never,
  );
  let uid = 1;
  const message = (from: number, text: string): Update =>
    ({ update_id: uid++, message: { message_id: uid, date: 0, chat: { id: from, type: 'private', first_name: 'X' }, from: { id: from, is_bot: false, first_name: 'X' }, text, entities: [{ type: 'bot_command', offset: 0, length: text.split(' ')[0]!.length }] } }) as Update;
  const sent = (): ApiCall[] => calls.filter((c) => c.method === 'sendMessage');
  return { bot, service, calls, message, sent };
}

import { IntelligenceTelegram } from './intelligence-telegram.js';
import { AskError } from './ask.service.js';
import type { AskResponse, SummarySearchHit } from '@commander/contracts';

const hit = (over: Partial<SummarySearchHit> = {}): SummarySearchHit => ({
  id: '00000000-0000-4000-8000-000000000001',
  sessionId: 'abcdef12-0000-4000-8000-000000000002',
  projectId: null,
  projectName: 'api <x>',
  machineId: '00000000-0000-4000-8000-000000000003',
  machineName: 'mac',
  taskKey: '6.1',
  summary: 'Login tuzatildi',
  done: [],
  files: [],
  openItems: [],
  model: 'haiku',
  tokensUsed: 1,
  promptCount: 2,
  sourceTokens: 3,
  trigger: 'ended',
  createdAt: '2026-11-14T10:00:00.000Z',
  updatedAt: '2026-11-14T10:00:00.000Z',
  headline: 'xato «login» tuzatildi <b>',
  rank: 1,
  ...over,
});

const answer: AskResponse = { queryId: '00000000-0000-4000-8000-000000000009', answer: 'Bugun 3 vazifa <bajarildi>', sources: [{ kind: 'project', id: null, label: 'api', href: null }], model: 'haiku', tookMs: 2500 };

function wire(opts: { search?: ReturnType<typeof vi.fn>; ask?: ReturnType<typeof vi.fn> } = {}) {
  const t = setup();
  const search = opts.search ?? vi.fn(async () => [hit()]);
  const ask = opts.ask ?? vi.fn(async () => answer);
  const access = { deviceFor: vi.fn(async () => 'dev-1') };
  const ext = new IntelligenceTelegram({ search } as never, { ask } as never, access as never);
  ext.onModuleInit();
  return { t, search, ask, ext, access };
}

let ext: IntelligenceTelegram | null = null;
afterEach(() => {
  ext?.onModuleDestroy();
  ext = null;
});

describe('Telegram /find', () => {
  it('searches summaries and escapes HTML while keeping the match markers as <b>', async () => {
    const w = wire();
    ext = w.ext;
    await w.t.service.onApplicationBootstrap();
    await w.t.bot.handleUpdate(w.t.message(OWNER, '/find login xato'));
    expect(w.search).toHaveBeenCalledWith({ q: 'login xato', limit: 5 });
    const text = String(w.t.sent()[0]!.payload.text);
    expect(text).toContain('<b>login</b>');
    expect(text).toContain('&lt;b&gt;');
    expect(text).toContain('api &lt;x&gt;');
    expect(text).toContain('abcdef12');
  });

  it('empty query shows usage; no hits says so; a stranger gets nothing', async () => {
    const w = wire({ search: vi.fn(async () => []) });
    ext = w.ext;
    await w.t.service.onApplicationBootstrap();
    await w.t.bot.handleUpdate(w.t.message(OWNER, '/find'));
    expect(String(w.t.sent()[0]!.payload.text)).toContain('/find');
    expect(w.search).not.toHaveBeenCalled();
    await w.t.bot.handleUpdate(w.t.message(OWNER, '/find zzzz'));
    expect(String(w.t.sent()[1]!.payload.text)).toContain('topilmadi');
    await w.t.bot.handleUpdate(w.t.message(STRANGER, '/find x'));
    expect(w.t.sent()).toHaveLength(2);
  });
});

describe('Telegram /ask and plain text', () => {
  it('/ask calls the assistant as the chat\'s telegram device and escapes the answer', async () => {
    const w = wire();
    ext = w.ext;
    await w.t.service.onApplicationBootstrap();
    await w.t.bot.handleUpdate(w.t.message(OWNER, '/ask bugun nima bo\'ldi?'));
    expect(w.ask).toHaveBeenCalledWith("bugun nima bo'ldi?", { deviceId: 'dev-1', actorKind: 'telegram', ip: null }, 'telegram');
    const text = String(w.t.sent()[0]!.payload.text);
    expect(text).toContain('&lt;bajarildi&gt;');
    expect(text).toContain('Manbalar: api');
  });

  it('plain text outside a flow is a question; slash-unknown commands and strangers are not', async () => {
    const w = wire();
    ext = w.ext;
    await w.t.service.onApplicationBootstrap();
    const plain = (from: number, text: string): Update => ({ update_id: 900 + text.length, message: { message_id: 5, date: 0, chat: { id: from, type: 'private', first_name: 'X' }, from: { id: from, is_bot: false, first_name: 'X' }, text } }) as Update;
    await w.t.bot.handleUpdate(plain(OWNER, 'qaysi loyihada token ko\'p ketdi'));
    expect(w.ask).toHaveBeenCalledTimes(1);
    await w.t.bot.handleUpdate(plain(OWNER, '/Users/ism/proj'));
    expect(w.ask).toHaveBeenCalledTimes(1);
    await w.t.bot.handleUpdate(plain(STRANGER, 'salom qalaysan'));
    expect(w.ask).toHaveBeenCalledTimes(1);
  });

  it('rate-limit / unavailable errors become a short warning; internals do not leak', async () => {
    const w = wire({ ask: vi.fn(async () => { throw new AskError(429, 'rate_limited', "Juda tez-tez so'rayapsiz", { retryAfterSeconds: 30 }); }) });
    ext = w.ext;
    await w.t.service.onApplicationBootstrap();
    await w.t.bot.handleUpdate(w.t.message(OWNER, '/ask savol'));
    expect(String(w.t.sent()[0]!.payload.text)).toContain('tez-tez');
    const w2 = wire({ ask: vi.fn(async () => { throw new Error('db password=hunter2'); }) });
    ext.onModuleDestroy();
    ext = w2.ext;
    await w2.t.service.onApplicationBootstrap();
    await w2.t.bot.handleUpdate(w2.t.message(OWNER, '/ask savol'));
    expect(String(w2.t.sent()[0]!.payload.text)).not.toContain('hunter2');
  });
});
