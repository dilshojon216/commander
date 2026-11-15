import { Bot } from 'grammy';
import type { Update } from 'grammy/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StepUpRegistry } from '../commands/step-up.js';
import { RealtimeBus } from '../realtime/realtime-bus.js';
import { telegramInvestigations } from './telegram-investigate.js';
import type { InvestigationTelegramPort } from './telegram-investigate.js';
import { TelegramService } from './telegram.service.js';
import type { TelegramOptions } from './telegram.options.js';
import { formatInvestigationCard, formatInvestigationResult } from '../investigations/investigations-telegram.js';

const TOKEN = '123456:FAKE-token-used-in-unit-tests-only';
const OWNER = 4242;
const INCIDENT = '5c0f2a44-1b7e-4f0a-9a31-0d5e6f7a8b9c';

interface Call { method: string; payload: Record<string, unknown> }

function setup(opts: { lockdown?: boolean; device?: string | null } = {}) {
  const calls: Call[] = [];
  const bot = new Bot(TOKEN, { botInfo: { id: 1, is_bot: true, first_name: 'C', username: 'c_bot', can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false, has_topics_enabled: false, allows_users_to_create_topics: false } as never });
  let mid = 100;
  bot.api.config.use(async (_p, method, payload) => {
    calls.push({ method, payload: payload as Record<string, unknown> });
    if (method === 'sendMessage') return { ok: true, result: { message_id: mid++, date: 0, chat: { id: (payload as { chat_id: number }).chat_id, type: 'private' } } } as never;
    return { ok: true, result: true } as never;
  });
  const access = { allowedIds: async () => new Set([String(OWNER)]), isAllowed: async (id: number | string) => String(id) === String(OWNER), deviceFor: async () => (opts.device === undefined ? 'tg-device' : opts.device), recordPending: async () => undefined, loadPrefs: async () => ({ notifyDone: true, mutedUntil: 0, limitAlerts: {} }), savePrefs: async () => undefined };
  const options: TelegramOptions = { token: TOKEN, polling: false, machineOfflineAfterMs: 120_000, machineGraceMs: 0, machineTickMs: 3_600_000, sessionMinGapMs: 60_000 };
  const service = new TelegramService(
    options, bot, access as never, {} as never, { list: async () => ({ items: [], onlineCount: 0 }) } as never, { list: async () => ({ items: [], nextCursor: null }) } as never, {} as never,
    { current: async () => ({}) } as never, { state: async () => ({ enabled: opts.lockdown === true, since: null }) } as never, { record: async () => undefined } as never,
    new RealtimeBus(), {} as never, new StepUpRegistry(), {} as never, undefined, undefined,
  );
  let u = 1;
  const press = (data: string, messageId = 100): Update => ({ update_id: u++, callback_query: { id: `cq${u}`, chat_instance: 'ci', from: { id: OWNER, is_bot: false, first_name: 'X' }, data, message: { message_id: messageId, date: 0, chat: { id: OWNER, type: 'private', first_name: 'X' } } } }) as Update;
  const flush = async (): Promise<void> => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };
  const sent = (m: string): Call[] => calls.filter((c) => c.method === m);
  const buttons = (c: Call | undefined): Array<{ text: string; callback_data: string }> => ((c?.payload.reply_markup as { inline_keyboard?: Array<Array<{ text: string; callback_data: string }>> } | undefined)?.inline_keyboard ?? []).flat();
  return { bot, service, calls, press, flush, sent, buttons };
}

describe('Telegram: "🔍 Claude tekshirsin" (6.4)', () => {
  const port = { preview: vi.fn(), start: vi.fn() } satisfies InvestigationTelegramPort;
  beforeEach(() => {
    port.preview.mockReset().mockResolvedValue({ ok: true, text: '🔍 karta' });
    port.start.mockReset().mockResolvedValue({ ok: true, text: '✅ ochildi' });
    telegramInvestigations.set(port);
  });
  afterEach(() => telegramInvestigations.set(null));

  async function ready(o: Parameters<typeof setup>[0] = {}) {
    const t = setup(o);
    await t.service.onApplicationBootstrap();
    return t;
  }

  it('hodisa xabarida tugma bor (stop tugmasi bilan birga ham); port yo\'q bo\'lsa tugma yo\'q', async () => {
    const t = await ready();
    await t.service.notifyText('server ogohlantirishi', { investigate: { kind: 'health', id: INCIDENT } });
    expect(t.buttons(t.sent('sendMessage')[0]).map((b) => b.text)).toEqual(['🔍 Claude tekshirsin']);
    await t.service.notifyText('watchdog', { stopSessionId: '5c0f2a44-1b7e-4f0a-9a31-0d5e6f7a8b9d', investigate: { kind: 'watchdog', id: INCIDENT } });
    expect(t.buttons(t.sent('sendMessage')[1]).map((b) => b.text)).toEqual(expect.arrayContaining(['🔍 Claude tekshirsin']));
    expect(t.buttons(t.sent('sendMessage')[1]).length).toBe(2);
    telegramInvestigations.set(null);
    await t.service.notifyText('x', { investigate: { kind: 'health', id: INCIDENT } });
    expect(t.buttons(t.sent('sendMessage')[2])).toEqual([]);
  });

  it('ikki bosqich: tugma -> karta (✅ Boshlash / ❌ Bekor), hali start YO\'Q; ✅ -> start(deviceId) va karta tahrirlanadi', async () => {
    const t = await ready();
    await t.service.notifyText('x', { investigate: { kind: 'health', id: INCIDENT } });
    const first = t.buttons(t.sent('sendMessage')[0])[0]!;
    await t.bot.handleUpdate(t.press(first.callback_data));
    expect(port.preview).toHaveBeenCalledWith('health', INCIDENT);
    expect(port.start).not.toHaveBeenCalled();
    const card = t.sent('sendMessage')[1]!;
    const btns = t.buttons(card);
    expect(btns.map((b) => b.text)).toEqual(['✅ Boshlash (plan)', '❌ Bekor']);
    await t.bot.handleUpdate(t.press(btns[0]!.callback_data, 101));
    expect(port.start).toHaveBeenCalledWith('health', INCIDENT, 'tg-device');
    const edit = t.sent('editMessageText').at(-1)!;
    expect(String(edit.payload.text)).toContain('ochildi');
    // eski tugma qayta bosilsa ham (ref eskirmagan): yana start so'raladi; ikki marta bosish himoyasi markazda (already_investigating)
  });

  it('❌ Bekor: start chaqirilmaydi', async () => {
    const t = await ready();
    await t.service.notifyText('x', { investigate: { kind: 'health', id: INCIDENT } });
    await t.bot.handleUpdate(t.press(t.buttons(t.sent('sendMessage')[0])[0]!.callback_data));
    const no = t.buttons(t.sent('sendMessage')[1]).find((b) => b.text === '❌ Bekor')!;
    await t.bot.handleUpdate(t.press(no.callback_data, 101));
    expect(port.start).not.toHaveBeenCalled();
    expect(String(t.sent('editMessageText').at(-1)!.payload.text)).toContain('Bekor');
  });

  it('preview ok=false (papka sozlanmagan): karta tugmasiz, start yo\'q', async () => {
    port.preview.mockResolvedValue({ ok: false, text: '⚠️ papka sozlanmagan' });
    const t = await ready();
    await t.service.notifyText('x', { investigate: { kind: 'health', id: INCIDENT } });
    await t.bot.handleUpdate(t.press(t.buttons(t.sent('sendMessage')[0])[0]!.callback_data));
    expect(t.buttons(t.sent('sendMessage')[1])).toEqual([]);
    expect(String(t.sent('sendMessage')[1]!.payload.text)).toContain('papka');
  });

  it('lockdown: karta ham, start ham yo\'q', async () => {
    const t = await ready({ lockdown: true });
    await t.service.notifyText('x', { investigate: { kind: 'health', id: INCIDENT } });
    await t.bot.handleUpdate(t.press(t.buttons(t.sent('sendMessage')[0])[0]!.callback_data));
    expect(port.preview).not.toHaveBeenCalled();
    expect(port.start).not.toHaveBeenCalled();
    expect(t.sent('answerCallbackQuery').some((c) => String(c.payload.text).includes('Lockdown'))).toBe(true);
  });

  it('chat uchun qurilma ruxsati bekor qilingan: start yo\'q', async () => {
    const t = await ready({ device: null });
    await t.service.notifyText('x', { investigate: { kind: 'health', id: INCIDENT } });
    await t.bot.handleUpdate(t.press(t.buttons(t.sent('sendMessage')[0])[0]!.callback_data));
    const go = t.buttons(t.sent('sendMessage')[1]).find((b) => b.text.startsWith('✅'))!;
    await t.bot.handleUpdate(t.press(go.callback_data, 101));
    expect(port.start).not.toHaveBeenCalled();
  });
});

describe('tekshiruv matnlari', () => {
  it('karta HTML-escape va plan rejimi eslatmasi', () => {
    const t = formatInvestigationCard({ machineName: 'a<b>', folder: '/x/<y>', model: 'sonnet' });
    expect(t).toContain('a&lt;b&gt;');
    expect(t).toContain('/x/&lt;y&gt;');
    expect(t).toContain('plan');
    expect(t).not.toContain('<b>a<b>');
  });
  it('natija: done / xato kodi tushuntirishi / jarayonda', () => {
    expect(formatInvestigationResult({ status: 'done', errorCode: null, folder: null })).toContain('ochildi');
    expect(formatInvestigationResult({ status: 'rejected', errorCode: 'cwd_invalid', folder: '/ops' })).toContain('mavjud emas');
    expect(formatInvestigationResult({ status: 'failed', errorCode: 'cwd_not_allowed', folder: '/ops' })).toContain('allow-root');
    expect(formatInvestigationResult({ status: 'sent', errorCode: null, folder: null })).toContain('⏳');
  });
});
