import { Bot } from 'grammy';
import type { Update } from 'grammy/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StepUpRegistry } from '../commands/step-up.js';
import { RealtimeBus } from '../realtime/realtime-bus.js';
import { telegramExtensions } from './telegram-extensions.js';
import { callbackKey, decodeCallback } from './callback-data.js';
import { TelegramService } from './telegram.service.js';
import type { TelegramOptions } from './telegram.options.js';

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

let unregister: (() => void) | null = null;
afterEach(() => {
  unregister?.();
  unregister = null;
});

describe('notifyText (watchdog/hisobot yuborish)', () => {
  it('allowlist chatiga HTML bilan yuboradi; stopSessionId bilan "To\'xtatish" tugmasi (imzolangan callback)', async () => {
    const t = setup();
    await t.service.onApplicationBootstrap();
    expect(await t.service.notifyText('🔥 <b>x</b>', { stopSessionId: 'sess-1' })).toBe(1);
    const call = t.sent()[0]!;
    expect(call.payload.chat_id).toBe(String(OWNER));
    expect(call.payload.parse_mode).toBe('HTML');
    const kb = (call.payload.reply_markup as { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> }).inline_keyboard.flat();
    expect(kb).toHaveLength(1);
    expect(kb[0]!.text).toContain('To\'xtatish');
    expect(kb[0]!.callback_data.length).toBeLessThanOrEqual(64);
    expect(decodeCallback(callbackKey(TOKEN), kb[0]!.callback_data, String(OWNER))).not.toBeNull();
  });

  it('tugmasiz xabar; bot o\'chiq bo\'lsa 0', async () => {
    const t = setup();
    await t.service.onApplicationBootstrap();
    await t.service.notifyText('hisobot');
    expect(t.sent()[0]!.payload.reply_markup).toBeUndefined();

    const off = new TelegramService({ token: null, polling: false, machineOfflineAfterMs: 1, machineGraceMs: 0, machineTickMs: 1000, sessionMinGapMs: 1 } as never, null, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, new RealtimeBus(), {} as never, new StepUpRegistry(), {} as never);
    expect(await off.notifyText('x')).toBe(0);
  });
});

describe('/report buyrug\'i', () => {
  it('ro\'yxatdan o\'tgan handler chaqiriladi: argument ("week") beriladi, har bo\'lak alohida xabar', async () => {
    const t = setup();
    await t.service.onApplicationBootstrap();
    const handler = vi.fn(async (_args: string) => ['birinchi', 'ikkinchi']);
    unregister = telegramExtensions.register('report', handler);
    await t.bot.handleUpdate(t.message(OWNER, '/report week'));
    expect(handler).toHaveBeenCalledWith('week', String(OWNER));
    expect(t.sent().map((c) => c.payload.text)).toEqual(['birinchi', 'ikkinchi']);
    await t.bot.handleUpdate(t.message(OWNER, '/report'));
    expect(handler).toHaveBeenLastCalledWith('', String(OWNER));
  });

  it('allowlist\'da yo\'q chat: handler chaqirilmaydi, javob yo\'q', async () => {
    const t = setup();
    await t.service.onApplicationBootstrap();
    const handler = vi.fn(async () => ['x']);
    unregister = telegramExtensions.register('report', handler);
    await t.bot.handleUpdate(t.message(STRANGER, '/report'));
    expect(handler).not.toHaveBeenCalled();
    expect(t.calls).toEqual([]);
  });

  it('handler yiqilsa: umumiy xato matni, center yiqilmaydi', async () => {
    const t = setup();
    await t.service.onApplicationBootstrap();
    unregister = telegramExtensions.register('report', async () => {
      throw new Error('db down');
    });
    await t.bot.handleUpdate(t.message(OWNER, '/report'));
    expect(String(t.sent()[0]!.payload.text)).toContain('bajarilmadi');
    expect(String(t.sent()[0]!.payload.text)).not.toContain('db down');
  });
});
