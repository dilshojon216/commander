import { HttpException } from '@nestjs/common';
import { Bot } from 'grammy';
import type { Update } from 'grammy/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandDto, MachineDto, RenderTemplateResponse, SessionDto, TemplateDto } from '@commander/contracts';
import { StepUpRegistry } from '../commands/step-up.js';
import { RealtimeBus } from '../realtime/realtime-bus.js';
import { TelegramService } from './telegram.service.js';
import type { TelegramOptions } from './telegram.options.js';

/** 3.4 (/new "Shablondan") va 3.10 (/s Remote Control) Telegram oqimlari: soxta Telegram API, soxta servislar. */

const TOKEN = '123456:FAKE-token-used-in-unit-tests-only';
const OWNER = 4242;
const SESSION_UUID = '7e57c0de-1111-4222-8333-444455556666';
const CLAUDE_SID = 'abcdef12-3456-7890-abcd-ef1234567890';
const TPL_A = '11111111-aaaa-4aaa-8aaa-111111111111';
const TPL_B = '22222222-bbbb-4bbb-8bbb-222222222222';
const URL1 = 'https://claude.ai/code/session_01Lb25s1rUPNVGEwNscyZi6y';
const CONTROL = { enabled: true, allowStart: true, allowPrompt: true, allowStop: true, allowSetMode: false, allowAutoMode: false, maxConcurrentStarted: 3, allowedRootCount: 1, centerKeyPinned: true, runningAsRoot: false, remoteControl: true };

const tpl = (over: Partial<TemplateDto> = {}): TemplateDto => ({
  id: TPL_A, scope: 'global', projectId: null, projectName: null, repoKey: null, name: 'Kod review', description: 'Review <qiladi>', body: 'SECRET-BODY {{project}}', variables: ['project'], model: null, permissionMode: null,
  builtin: true, createdByDeviceId: null, createdAt: '', updatedAt: '', ...over,
});
const render = (over: Partial<RenderTemplateResponse> = {}): RenderTemplateResponse => ({ templateId: TPL_A, text: 'Review commander main', length: 21, variables: [], missing: [], tooLong: false, model: null, permissionMode: null, ...over });

const machine = (over: Partial<MachineDto> = {}): MachineDto => ({ id: 'm1', slug: 'mac-mini', displayName: 'Mac mini', hostname: 'mac', online: true, control: CONTROL, ...over }) as MachineDto;
const session = (over: Partial<SessionDto> = {}): SessionDto =>
  ({
    id: SESSION_UUID, claudeSessionId: CLAUDE_SID, machineId: 'm1', machineSlug: 'mac-mini', machineName: 'Mac mini', projectId: null, projectName: 'commander', cwd: '/w/commander', name: null, kind: 'tmux',
    status: 'idle', message: null, notificationType: null, model: 'haiku', permissionMode: 'default', startedAt: new Date().toISOString(), statusSince: new Date().toISOString(), lastSeenAt: new Date().toISOString(),
    endedAt: null, endReason: null, staleSince: null, pendingApprovals: 0, controllable: true, controlReason: null, controls: { prompt: true, stop: true, setMode: false, remoteControl: true }, ...over,
  }) as SessionDto;

const rcCommand = (over: Partial<CommandDto> = {}): CommandDto =>
  ({
    id: '5c0f2a44-1b7e-4f0a-9a31-0d5e6f7a8b9c', type: 'session.remote_control', status: 'sent', machineId: 'm1', machineSlug: 'mac-mini', sessionId: SESSION_UUID, claudeSessionId: CLAUDE_SID, cwd: null, permissionMode: null, model: null,
    promptLength: null, promptPreview: null, requestedByDeviceId: 'telegram-device-1', stepUp: { required: false, via: null, expiresAt: null, confirmedAt: null, confirmedByDeviceId: null }, errorCode: null, errorMessage: null,
    result: null, createdAt: new Date().toISOString(), sentAt: null, ackedAt: null, finishedAt: null, expiresAt: new Date().toISOString(), ...over,
  }) as CommandDto;

interface ApiCall { method: string; payload: Record<string, unknown> }

function setup(opts: { templates?: { list: TemplateDto[]; render?: () => Promise<RenderTemplateResponse> } | null; lockdown?: boolean; sess?: SessionDto } = {}) {
  const calls: ApiCall[] = [];
  const bot = new Bot(TOKEN, {
    botInfo: { id: 1, is_bot: true, first_name: 'C', username: 'c_bot', can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false, has_topics_enabled: false, allows_users_to_create_topics: false } as never,
  });
  let nextMessageId = 100;
  bot.api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload: payload as Record<string, unknown> });
    if (method === 'sendMessage') return { ok: true, result: { message_id: nextMessageId++, date: 0, chat: { id: (payload as { chat_id: number }).chat_id, type: 'private' } } } as never;
    return { ok: true, result: true } as never;
  });
  const sess = opts.sess ?? session();
  const access = { allowedIds: vi.fn(async () => new Set([String(OWNER)])), isAllowed: vi.fn(async () => true), deviceFor: vi.fn(async () => 'telegram-device-1'), recordPending: vi.fn(), loadPrefs: vi.fn(async () => ({ notifyDone: true, mutedUntil: 0, limitAlerts: {} })), savePrefs: vi.fn() };
  const machines = { list: vi.fn(async () => ({ items: [machine()], onlineCount: 1 })), findById: vi.fn(async () => machine()) };
  const sessionsSvc = { list: vi.fn(async () => ({ items: [sess], nextCursor: null })), get: vi.fn(async () => sess), findByRefs: vi.fn(async () => [sess]) };
  const lockdown = { state: vi.fn(async () => ({ enabled: opts.lockdown === true, since: null })) };
  const commandState = { dto: rcCommand() };
  const commands = {
    getDto: vi.fn(async () => commandState.dto),
    create: vi.fn(async (..._a: unknown[]) => ({ command: commandState.dto, idempotent: false })),
    waitFinished: vi.fn(async () => ({ command: rcCommand({ status: 'done', result: { remoteControl: { enabled: true, name: 'cmdr-abcdef12', url: URL1 } } }), timedOut: false })),
  };
  const usageSvc = { projects: vi.fn(async () => ({ items: [{ id: 'p2', machineId: 'm1', name: 'commander', path: '/w/commander', lastUsedAt: '2026-11-13T00:00:00Z' }] })) };
  const templates = opts.templates
    ? {
        listForCwd: vi.fn(async () => opts.templates!.list),
        render: vi.fn(opts.templates.render ?? (async () => render())),
      }
    : undefined;
  const options: TelegramOptions = { token: TOKEN, polling: false, machineOfflineAfterMs: 120_000, machineGraceMs: 0, machineTickMs: 3_600_000, sessionMinGapMs: 60_000 };
  const service = new TelegramService(
    options, bot, access as never, {} as never, machines as never, sessionsSvc as never, usageSvc as never,
    { current: vi.fn() } as never, lockdown as never, { record: vi.fn() } as never, new RealtimeBus(), commands as never, new StepUpRegistry(), {} as never, undefined, undefined, templates as never,
  );
  let updateId = 1;
  const message = (from: number, text: string): Update => ({ update_id: updateId++, message: { message_id: updateId, date: 0, chat: { id: from, type: 'private', first_name: 'X' }, from: { id: from, is_bot: false, first_name: 'X', username: 's' }, text, entities: text.startsWith('/') ? [{ type: 'bot_command', offset: 0, length: text.split(' ')[0]!.length }] : [] } }) as Update;
  const press = (data: string, messageId = 100): Update => ({ update_id: updateId++, callback_query: { id: `cq${updateId}`, chat_instance: 'ci', from: { id: OWNER, is_bot: false, first_name: 'X' }, data, message: { message_id: messageId, date: 0, chat: { id: OWNER, type: 'private', first_name: 'X' } } } }) as Update;
  const sent = (m: string): ApiCall[] => calls.filter((c) => c.method === m);
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 12; i++) await new Promise((r) => setImmediate(r));
  };
  const buttons = (c: ApiCall | undefined): Array<{ text: string; callback_data: string }> =>
    ((c?.payload.reply_markup as { inline_keyboard?: Array<Array<{ text: string; callback_data: string }>> } | undefined)?.inline_keyboard ?? []).flat();
  return { bot, calls, service, commands, commandState, templates, sessionsSvc, message, press, sent, flush, buttons };
}

describe('3.4 /new: "Shablondan" bosqichi', () => {
  let t: ReturnType<typeof setup>;
  const lastId = (): number => 100 + t.sent('sendMessage').length - 1;
  const lastSent = () => t.sent('sendMessage').at(-1)!;
  const lastEdit = () => t.sent('editMessageText').at(-1)!;
  const tap = async (call: ApiCall | undefined, label: string, messageId: number): Promise<void> => {
    const b = t.buttons(call).find((x) => x.text.includes(label));
    if (!b) throw new Error(`button "${label}" not found in ${JSON.stringify(t.buttons(call).map((x) => x.text))}`);
    await t.bot.handleUpdate(t.press(b.callback_data, messageId));
    await t.flush();
  };
  async function toTaskStage(): Promise<number> {
    await t.bot.handleUpdate(t.message(OWNER, '/new'));
    await tap(lastSent(), 'Mac mini', lastId());
    const card = lastId();
    await tap(lastEdit(), 'commander', card);
    await tap(lastEdit(), 'Sonnet', card);
    await tap(lastEdit(), 'Qo\'lda', card);
    return card;
  }

  it('shablon bor: kutish kartasida "Shablondan (N)"; ro\'yxat faqat NOM/tavsifni ko\'rsatadi (matn emas, HTML escape)', async () => {
    t = setup({ templates: { list: [tpl({ name: 'A <b>x</b>' }), tpl({ id: TPL_B, name: 'Deploy', scope: 'project' })] } });
    await t.service.onApplicationBootstrap();
    const card = await toTaskStage();
    expect(t.buttons(lastEdit()).map((b) => b.text)).toEqual(['📋 Shablondan (2)', '❌ Bekor']);
    expect(t.templates!.listForCwd).toHaveBeenCalledWith('m1', '/w/commander');
    await tap(lastEdit(), 'Shablondan', card);
    const text = String(lastEdit().payload.text);
    expect(text).toContain('A &lt;b&gt;x&lt;/b&gt;');
    expect(text).not.toContain('SECRET-BODY');
    expect(t.buttons(lastEdit()).map((b) => b.text)).toEqual(['🌐 A <b>x</b>', '📁 Deploy', '↩️ Orqaga']);
    // orqaga: kutish kartasi
    await tap(lastEdit(), 'Orqaga', card);
    expect(t.buttons(lastEdit()).map((b) => b.text)).toEqual(['📋 Shablondan (2)', '❌ Bekor']);
  });

  it('tanlash: markazda render (mashina+papka kontekstida), xulosa kartasi; "Ochish" session.start yuboradi (matn = render natijasi)', async () => {
    t = setup({ templates: { list: [tpl()] } });
    await t.service.onApplicationBootstrap();
    const card = await toTaskStage();
    await tap(lastEdit(), 'Shablondan', card);
    await tap(lastEdit(), 'Kod review', card);
    expect(t.templates!.render).toHaveBeenCalledWith(TPL_A, { machineId: 'm1', cwd: '/w/commander' });
    expect(String(lastEdit().payload.text)).toContain('Review commander main');
    expect(t.buttons(lastEdit()).some((b) => b.text.includes('Ochish'))).toBe(true);
    await tap(lastEdit(), 'Ochish', card);
    expect(t.commands.create).toHaveBeenCalledTimes(1);
    expect(t.commands.create.mock.calls[0]![0]).toMatchObject({ type: 'session.start', machineId: 'm1', cwd: '/w/commander', prompt: 'Review commander main', permissionMode: 'default' });
    expect(t.commands.create.mock.calls[0]![1]).toMatchObject({ actorKind: 'telegram', confirmation: 'telegram_inline' });
  });

  it('yetishmayotgan o\'zgaruvchi: ogohlantirish, summary\'ga o\'tilmaydi, qo\'lda yozish mumkin', async () => {
    t = setup({ templates: { list: [tpl()], render: async () => render({ missing: ['task_key'], text: '{{task_key}}' }) } });
    await t.service.onApplicationBootstrap();
    const card = await toTaskStage();
    await tap(lastEdit(), 'Shablondan', card);
    await tap(lastEdit(), 'Kod review', card);
    expect(String(lastEdit().payload.text)).toContain('{{task_key}}');
    expect(t.buttons(lastEdit()).map((b) => b.text)).toEqual(['📋 Shablondan (1)', '❌ Bekor']);
    expect(t.commands.create).not.toHaveBeenCalled();
    await t.bot.handleUpdate(t.message(OWNER, 'qo\'lda yozilgan vazifa'));
    await t.flush();
    expect(String(lastSent().payload.text)).toContain('qo\'lda yozilgan vazifa');
  });

  it('juda uzun render va 404 (shablon o\'chirilgan) tushuntirish bilan qaytadi', async () => {
    t = setup({ templates: { list: [tpl()], render: async () => render({ tooLong: true }) } });
    await t.service.onApplicationBootstrap();
    let card = await toTaskStage();
    await tap(lastEdit(), 'Shablondan', card);
    await tap(lastEdit(), 'Kod review', card);
    expect(String(lastEdit().payload.text)).toContain('juda uzun');

    t = setup({ templates: { list: [tpl()], render: async () => { throw new HttpException({ error: 'not_found' }, 404); } } });
    await t.service.onApplicationBootstrap();
    card = await toTaskStage();
    await tap(lastEdit(), 'Shablondan', card);
    await tap(lastEdit(), 'Kod review', card);
    expect(t.sent('answerCallbackQuery').at(-1)!.payload.text).toBe('Shablon topilmadi');
  });

  it('shablon yo\'q yoki servis yo\'q: kutish kartasida tugma YO\'Q (eski xatti-harakat)', async () => {
    for (const templates of [null, { list: [] }]) {
      t = setup({ templates });
      await t.service.onApplicationBootstrap();
      await toTaskStage();
      expect(t.buttons(lastEdit())).toEqual([]);
    }
  });

  it('lockdown: shablon tugmasi ham bloklanadi', async () => {
    t = setup({ templates: { list: [tpl()] } });
    await t.service.onApplicationBootstrap();
    const card = await toTaskStage();
    const btnData = t.buttons(lastEdit()).find((b) => b.text.includes('Shablondan'))!.callback_data;
    t = Object.assign(t, {});
    // lockdown'ni yoqamiz (yangi holat shu servisda): tugma bosilganda rad
    const svc = t.service as unknown as { lockdown: { state: () => Promise<{ enabled: boolean }> } };
    svc.lockdown.state = async () => ({ enabled: true });
    await t.bot.handleUpdate(t.press(btnData, card));
    await t.flush();
    expect(t.sent('answerCallbackQuery').at(-1)!.payload.text).toBe('Lockdown: buyruqlar bloklangan');
  });
});

describe('3.10 /s: Remote Control tugmasi', () => {
  let t: ReturnType<typeof setup>;
  const lastCard = () => t.sent('sendMessage').at(-1)!;
  const btn = (call: ApiCall | undefined, label: string): string => {
    const b = t.buttons(call).find((x) => x.text.includes(label));
    if (!b) throw new Error(`button "${label}" not found in ${JSON.stringify(t.buttons(call).map((x) => x.text))}`);
    return b.callback_data;
  };

  beforeEach(async () => {
    t = setup();
    await t.service.onApplicationBootstrap();
  });

  it('kartada "To\'xtatish" va "Remote Control: yoqish" tugmalari; sessiya RC ma\'lumoti kartada', async () => {
    await t.bot.handleUpdate(t.message(OWNER, '/s abcdef12'));
    await t.flush();
    expect(t.buttons(lastCard()).map((b) => b.text)).toEqual(['⏹ To\'xtatish', '🛰 Remote Control: yoqish']);
  });

  it('RC ma\'lumoti bor sessiya: karta nom va o\'chirish tugmasi; RC qatori HTML-escape', async () => {
    t = setup({ sess: session({ remoteControl: { enabled: true, name: 'a<b>', since: new Date().toISOString(), url: URL1 } }) });
    await t.service.onApplicationBootstrap();
    await t.bot.handleUpdate(t.message(OWNER, '/s abcdef12'));
    await t.flush();
    const text = String(lastCard().payload.text);
    expect(text).toContain('🛰 Remote Control: yoniq');
    expect(text).toContain('a&lt;b&gt;');
    expect(t.buttons(lastCard()).map((b) => b.text)).toEqual(['⏹ To\'xtatish', '🛰 Remote Control: o\'chirish']);
  });

  it('tugma faqat controls.remoteControl bo\'lsa (bg/siyosat/eski agentd uchun yo\'q)', async () => {
    t = setup({ sess: session({ kind: 'bg', controls: { prompt: true, stop: true, setMode: false } }) });
    await t.service.onApplicationBootstrap();
    await t.bot.handleUpdate(t.message(OWNER, '/s abcdef12'));
    await t.flush();
    expect(t.buttons(lastCard()).map((b) => b.text)).toEqual(['⏹ To\'xtatish']);
  });

  it('yoqish: tasdiq so\'raladi, "Ha" = session.remote_control(enable) + telegram_inline; natija kartasi nom va havolani ko\'rsatadi', async () => {
    await t.bot.handleUpdate(t.message(OWNER, '/s abcdef12'));
    await t.flush();
    const cardId = 100 + t.sent('sendMessage').length - 1;
    await t.bot.handleUpdate(t.press(btn(lastCard(), 'Remote Control'), cardId));
    await t.flush();
    expect(t.commands.create).not.toHaveBeenCalled(); // tasdiqsiz yuborilmaydi
    const confirm = t.sent('editMessageReplyMarkup').at(-1)!;
    expect(t.buttons(confirm).map((b) => b.text)).toEqual(['✅ Ha, claude.ai dan boshqarishga och', '↩️ Orqaga']);
    expect(String(t.sent('answerCallbackQuery').at(-1)!.payload.text)).toContain('claude.ai');

    await t.bot.handleUpdate(t.press(btn(confirm, 'Ha'), cardId));
    await t.flush();
    expect(t.commands.create).toHaveBeenCalledTimes(1);
    const [body, actor] = t.commands.create.mock.calls[0]!;
    expect(body).toEqual({ type: 'session.remote_control', sessionId: SESSION_UUID, enable: true });
    expect(actor).toMatchObject({ deviceId: 'telegram-device-1', actorKind: 'telegram', confirmation: 'telegram_inline' });
    const finalEdit = t.sent('editMessageText').at(-1)!;
    expect(String(finalEdit.payload.text)).toContain('✅ Yoqildi');
    expect(String(finalEdit.payload.text)).toContain('cmdr-abcdef12');
    expect(String(finalEdit.payload.text)).toContain(URL1);
  });

  it('"Orqaga" tasdiqni qaytaradi va hech narsa yuborilmaydi', async () => {
    await t.bot.handleUpdate(t.message(OWNER, '/s abcdef12'));
    await t.flush();
    const cardId = 100 + t.sent('sendMessage').length - 1;
    await t.bot.handleUpdate(t.press(btn(lastCard(), 'Remote Control'), cardId));
    await t.flush();
    await t.bot.handleUpdate(t.press(btn(t.sent('editMessageReplyMarkup').at(-1), 'Orqaga'), cardId));
    await t.flush();
    expect(t.buttons(t.sent('editMessageReplyMarkup').at(-1)).map((b) => b.text)).toEqual(['⏹ To\'xtatish', '🛰 Remote Control: yoqish']);
    expect(t.commands.create).not.toHaveBeenCalled();
  });

  it('o\'chirish: tasdiqsiz, inline bayrog\'isiz yuboriladi', async () => {
    t = setup({ sess: session({ remoteControl: { enabled: true, name: 'x', since: new Date().toISOString() } }) });
    t.commands.waitFinished.mockResolvedValue({ command: rcCommand({ status: 'done', result: { remoteControl: { enabled: false } } }), timedOut: false });
    await t.service.onApplicationBootstrap();
    await t.bot.handleUpdate(t.message(OWNER, '/s abcdef12'));
    await t.flush();
    const cardId = 100 + t.sent('sendMessage').length - 1;
    await t.bot.handleUpdate(t.press(btn(lastCard(), 'o\'chirish'), cardId));
    await t.flush();
    const [body, actor] = t.commands.create.mock.calls[0]!;
    expect(body).toEqual({ type: 'session.remote_control', sessionId: SESSION_UUID, enable: false });
    expect((actor as { confirmation?: string }).confirmation).toBeUndefined();
    expect(String(t.sent('editMessageText').at(-1)!.payload.text)).toContain('O\'chirildi');
  });

  it('lockdown: yoqish/o\'chirish tugmalari bloklanadi', async () => {
    t = setup({ lockdown: true });
    await t.service.onApplicationBootstrap();
    await t.bot.handleUpdate(t.message(OWNER, '/s abcdef12'));
    await t.flush();
    await t.bot.handleUpdate(t.press(btn(lastCard(), 'Remote Control'), 100));
    await t.flush();
    expect(t.sent('answerCallbackQuery').at(-1)!.payload.text).toBe('Lockdown: buyruqlar bloklangan');
    expect(t.commands.create).not.toHaveBeenCalled();
  });

  it('buyruq rad etilsa (agentd siyosati) xato matni, natija kartasi yo\'q', async () => {
    t.commands.create.mockRejectedValueOnce(new HttpException({ error: 'command_in_flight' }, 409));
    await t.bot.handleUpdate(t.message(OWNER, '/s abcdef12'));
    await t.flush();
    const cardId = 100 + t.sent('sendMessage').length - 1;
    await t.bot.handleUpdate(t.press(btn(lastCard(), 'Remote Control'), cardId));
    await t.flush();
    await t.bot.handleUpdate(t.press(btn(t.sent('editMessageReplyMarkup').at(-1), 'Ha'), cardId));
    await t.flush();
    expect(String(t.sent('answerCallbackQuery').at(-1)!.payload.text)).toContain('boshqa buyruq');
    expect(t.sent('editMessageText')).toHaveLength(0);
  });
});
