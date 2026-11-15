import { ConflictException, ForbiddenException } from '@nestjs/common';
import { Bot } from 'grammy';
import type { Update } from 'grammy/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApprovalDto, CommandDto, MachineDto, SessionDto } from '@commander/contracts';
import { StepUpRegistry } from '../commands/step-up.js';
import { RealtimeBus } from '../realtime/realtime-bus.js';
import { callbackKey, decodeCallback, encodeCallback } from './callback-data.js';
import { formatApproval } from './telegram-format.js';
import { TelegramService } from './telegram.service.js';
import type { TelegramOptions } from './telegram.options.js';

const TOKEN = '123456:FAKE-token-used-in-unit-tests-only';
const OWNER = 4242;
const STRANGER = 9999;
const APPROVAL_ID = '0b7f3c1e-9d2a-4c55-8f10-aa11bb22cc33';
const key = callbackKey(TOKEN);

interface ApiCall {
  method: string;
  payload: Record<string, unknown>;
}

const baseApproval = (over: Partial<ApprovalDto> = {}): ApprovalDto => ({
  id: APPROVAL_ID,
  machineId: '11111111-1111-4111-8111-111111111111',
  machineSlug: 'mac-mini',
  sessionId: null,
  claudeSessionId: 's1',
  projectName: 'commander',
  cwd: '/w/commander',
  toolName: 'Bash',
  toolInputRedacted: '{"command":"rm -rf build"}',
  toolInputFullHash: 'a'.repeat(64),
  status: 'pending',
  behavior: null,
  decisionMessage: null,
  decidedByDeviceId: null,
  decidedAt: null,
  delivered: null,
  requestedAt: new Date().toISOString(),
  deadline: new Date(Date.now() + 5 * 60_000).toISOString(),
  resolvedAt: null,
  kind: 'tool',
  plan: null,
  autoRuleId: null,
  questions: null,
  answers: null,
  ...over,
});

const COMMAND_ID = '5c0f2a44-1b7e-4f0a-9a31-0d5e6f7a8b9c';
function baseCommand(over: Partial<CommandDto> = {}): CommandDto {
  return {
    id: COMMAND_ID,
    type: 'session.start',
    status: 'awaiting_confirmation',
    machineId: 'm1',
    machineSlug: 'mac-mini',
    sessionId: null,
    claudeSessionId: null,
    cwd: '/w/commander',
    permissionMode: 'acceptEdits',
    model: 'haiku',
    promptLength: 21,
    promptPreview: 'fix <b>the</b> bug & token=sk-ant-abcdefghijklmnop',
    requestedByDeviceId: '99999999-9999-4999-8999-999999999999',
    stepUp: { required: true, via: 'telegram', expiresAt: new Date(Date.now() + 120_000).toISOString(), confirmedAt: null, confirmedByDeviceId: null },
    errorCode: null,
    errorMessage: null,
    result: null,
    createdAt: new Date().toISOString(),
    sentAt: null,
    ackedAt: null,
    finishedAt: null,
    expiresAt: new Date(Date.now() + 120_000).toISOString(),
    ...over,
  };
}

const machine = (over: Partial<MachineDto> = {}): MachineDto =>
  ({ id: 'm1', slug: 'mac-mini', displayName: null, hostname: 'mac', online: true, sessions: { open: 2, working: 1, waiting: 1, awaitingApproval: 0, idle: 0, done: 0 }, ...over }) as MachineDto;

const session = (over: Partial<SessionDto> = {}): SessionDto =>
  ({ id: 'sess-1', machineId: 'm1', machineName: 'mac', projectName: 'commander', message: 'kutmoqda', status: 'working', staleSince: null, endedAt: null, ...over }) as SessionDto;

function setup(opts: { allowed?: string[]; lockdown?: boolean; queue?: unknown; limits?: unknown } = {}) {
  const calls: ApiCall[] = [];
  const bot = new Bot(TOKEN, {
    botInfo: { id: 1, is_bot: true, first_name: 'Commander', username: 'commander_test_bot', can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false, has_topics_enabled: false, allows_users_to_create_topics: false } as never,
  });
  let nextMessageId = 100;
  // Telegram API'ga tarmoq so'rovi YO'Q: har chaqiruv yozib olinadi va soxta javob qaytariladi.
  bot.api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload: payload as Record<string, unknown> });
    if (method === 'sendMessage') return { ok: true, result: { message_id: nextMessageId++, date: 0, chat: { id: (payload as { chat_id: number }).chat_id, type: 'private' } } } as never;
    return { ok: true, result: true } as never;
  });

  const allowed = new Set(opts.allowed ?? [String(OWNER)]);
  const prefsStore = { notifyDone: true, mutedUntil: 0, limitAlerts: {} as Record<string, number> };
  const approvalsState = { dto: baseApproval() };
  const access = {
    allowedIds: vi.fn(async () => allowed),
    isAllowed: vi.fn(async (id: number | string) => allowed.has(String(id))),
    deviceFor: vi.fn(async () => 'telegram-device-1'),
    recordPending: vi.fn(async () => undefined),
    loadPrefs: vi.fn(async () => ({ ...prefsStore })),
    savePrefs: vi.fn(async () => undefined),
  };
  const approvals = {
    getDto: vi.fn(async () => approvalsState.dto),
    list: vi.fn(async () => ({ pending: approvalsState.dto.status === 'pending' ? [approvalsState.dto] : [], recent: [] })),
    decide: vi.fn(async (_id: string, body: { behavior: 'allow' | 'deny' }) => {
      approvalsState.dto = baseApproval({ status: body.behavior === 'allow' ? 'approved' : 'denied', behavior: body.behavior, resolvedAt: new Date().toISOString() });
      return { approval: approvalsState.dto, delivered: true, idempotent: false };
    }),
  };
  const machines = {
    list: vi.fn(async () => ({ items: [machine()], onlineCount: 1 })),
    findById: vi.fn(async () => machine()),
  };
  const sessionsSvc = {
    list: vi.fn(async () => ({ items: [], nextCursor: null })),
    findByRefs: vi.fn(async () => [session({ status: 'waiting' })]),
  };
  const lockdown = { state: vi.fn(async () => ({ enabled: opts.lockdown === true, since: null })) };
  const audit = { record: vi.fn(async () => undefined) };
  const bus = new RealtimeBus();
  const commandState = { dto: baseCommand() };
  const commands = {
    getDto: vi.fn(async () => commandState.dto),
    create: vi.fn(async (..._args: unknown[]) => ({ command: commandState.dto, idempotent: false })),
    confirm: vi.fn(async () => {
      commandState.dto = { ...commandState.dto, status: 'sent' };
      return { outcome: 'confirmed' as const, command: commandState.dto };
    }),
    cancel: vi.fn(async () => {
      commandState.dto = { ...commandState.dto, status: 'rejected', errorCode: 'step_up_cancelled' };
      return { cancelled: true, command: commandState.dto };
    }),
  };
  const stepUp = new StepUpRegistry();
  const rules = { create: vi.fn(async (..._a: unknown[]) => ({ id: 7 })) };
  const usageSvc = {
    summary: vi.fn(),
    projects: vi.fn(async () => ({
      items: [
        { id: 'p1', machineId: 'm1', name: 'old-proj', path: '/w/old-proj', lastUsedAt: '2026-11-01T00:00:00Z' },
        { id: 'p2', machineId: 'm1', name: 'commander', path: '/w/commander', lastUsedAt: '2026-11-13T00:00:00Z' },
        { id: 'p3', machineId: 'm2', name: 'other-machine', path: '/x/other', lastUsedAt: '2026-11-13T00:00:00Z' },
      ],
    })),
  };
  const options: TelegramOptions = { token: TOKEN, polling: false, machineOfflineAfterMs: 120_000, machineGraceMs: 0, machineTickMs: 3_600_000, sessionMinGapMs: 60_000 };
  const service = new TelegramService(
    options,
    bot,
    access as never,
    approvals as never,
    machines as never,
    sessionsSvc as never,
    usageSvc as never,
    (opts.limits ?? { current: vi.fn(async () => ({ computedAt: '', freshSeconds: 180, fiveHour: null, sevenDay: null })) }) as never,
    lockdown as never,
    audit as never,
    bus,
    commands as never,
    stepUp,
    rules as never,
    undefined,
    opts.queue as never,
  );

  let updateId = 1;
  const message = (from: number, text: string): Update => ({ update_id: updateId++, message: { message_id: updateId, date: 0, chat: { id: from, type: 'private', first_name: 'X' }, from: { id: from, is_bot: false, first_name: 'X', username: 'someone' }, text, entities: text.startsWith('/') ? [{ type: 'bot_command', offset: 0, length: text.split(' ')[0]!.length }] : [] } }) as Update;
  const press = (from: number, data: string, chatId = from, messageId = 100): Update =>
    ({ update_id: updateId++, callback_query: { id: `cq${updateId}`, chat_instance: 'ci', from: { id: from, is_bot: false, first_name: 'X' }, data, message: { message_id: messageId, date: 0, chat: { id: chatId, type: 'private', first_name: 'X' } } } }) as Update;
  const sent = (method: string): ApiCall[] => calls.filter((c) => c.method === method);
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
  };
  /** Yuborilgan inline tugmalar: [{text, callback_data}]. */
  const buttons = (call: ApiCall | undefined): Array<{ text: string; callback_data: string }> =>
    ((call?.payload.reply_markup as { inline_keyboard?: Array<Array<{ text: string; callback_data: string }>> } | undefined)?.inline_keyboard ?? []).flat();
  return { bot, calls, service, usageSvc, access, rules, commands, commandState, stepUp, approvals, approvalsState, machines, sessionsSvc, lockdown, audit, bus, message, press, sent, flush, buttons, prefsStore };
}

describe('TelegramService', () => {
  let t: ReturnType<typeof setup>;

  describe('allowlist darvozasi', () => {
    beforeEach(async () => {
      t = setup();
      await t.service.onApplicationBootstrap();
    });

    it('allowlist\'da bo\'lmagan chat: HECH QANDAY javob yo\'q, /start esa pending\'ga yoziladi', async () => {
      await t.bot.handleUpdate(t.message(STRANGER, '/start'));
      await t.bot.handleUpdate(t.message(STRANGER, '/status'));
      expect(t.calls).toEqual([]);
      expect(t.access.recordPending).toHaveBeenCalledTimes(1);
      expect(t.access.recordPending).toHaveBeenCalledWith({ chatId: String(STRANGER), username: 'someone', name: 'X' });
      expect(t.audit.record).toHaveBeenCalledTimes(1); // bir chatga 10 daqiqada bitta audit
      expect(t.audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'telegram.rejected', actorKind: 'system' }));
      expect(t.approvals.decide).not.toHaveBeenCalled();
    });

    it('allowlist\'da yo\'q chatdan callback: decide chaqirilmaydi, faqat matnsiz answerCallbackQuery', async () => {
      await t.bot.handleUpdate(t.press(STRANGER, 'd' + '0'.repeat(32) + 'A'.repeat(16)));
      expect(t.approvals.decide).not.toHaveBeenCalled();
      expect(t.calls.map((c) => c.method)).toEqual(['answerCallbackQuery']);
      expect(t.calls[0]!.payload.text).toBeUndefined();
    });

    it('chat.id !== from.id (guruh/yo\'naltirilgan) rad etiladi', async () => {
      await t.bot.handleUpdate(t.press(STRANGER, 'x', OWNER)); // from=STRANGER, chat=OWNER
      expect(t.access.isAllowed).not.toHaveBeenCalled();
      expect(t.approvals.decide).not.toHaveBeenCalled();
    });

    it('allowlist\'dagi chat /start da yordam oladi', async () => {
      await t.bot.handleUpdate(t.message(OWNER, '/start'));
      expect(t.sent('sendMessage')).toHaveLength(1);
      expect(String(t.sent('sendMessage')[0]!.payload.text)).toContain('/status');
      expect(t.access.recordPending).not.toHaveBeenCalled();
    });
  });

  describe('approval oqimi (fake Telegram API)', () => {
    beforeEach(async () => {
      t = setup();
      await t.service.onApplicationBootstrap();
    });

    it('approval.created -> tugmali xabar; Rad callback -> decide(deny, actor telegram) -> xabar tahrirlanadi, tugmalar yo\'q', async () => {
      t.bus.publish({ type: 'approval.created', approvalId: APPROVAL_ID });
      await t.flush();
      const msg = t.sent('sendMessage')[0]!;
      expect(msg.payload.parse_mode).toBe('HTML');
      expect(String(msg.payload.text)).toContain('Tool: <code>Bash</code>');
      const btns = t.buttons(msg);
      expect(btns.map((b) => b.text)).toEqual(['✅ Ruxsat', '❌ Rad']);

      const deny = btns.find((b) => b.text === '❌ Rad')!;
      await t.bot.handleUpdate(t.press(OWNER, deny.callback_data));

      expect(t.approvals.decide).toHaveBeenCalledWith(APPROVAL_ID, { behavior: 'deny', message: expect.any(String) }, { deviceId: 'telegram-device-1', actorKind: 'telegram', ip: null });
      const edit = t.sent('editMessageText').at(-1)!;
      expect(String(edit.payload.text)).toContain('❌ <b>Rad etildi</b>');
      expect((edit.payload.reply_markup as { inline_keyboard: unknown[] }).inline_keyboard).toEqual([]);
      expect(t.sent('answerCallbackQuery')).toHaveLength(1);
    });

    it('Ruxsat ikki bosqichli: birinchi bosish decide qilmaydi, "Ha, ruxsat ber" qiladi', async () => {
      t.bus.publish({ type: 'approval.created', approvalId: APPROVAL_ID });
      await t.flush();
      const ask = t.buttons(t.sent('sendMessage')[0]).find((b) => b.text === '✅ Ruxsat')!;
      await t.bot.handleUpdate(t.press(OWNER, ask.callback_data));
      expect(t.approvals.decide).not.toHaveBeenCalled();
      const confirmMarkup = t.sent('editMessageReplyMarkup').at(-1)!;
      const confirmBtns = t.buttons(confirmMarkup);
      expect(confirmBtns.map((b) => b.text)).toEqual(['✅ Ha, ruxsat ber', '↩️ Orqaga']);

      await t.bot.handleUpdate(t.press(OWNER, confirmBtns[0]!.callback_data));
      expect(t.approvals.decide).toHaveBeenCalledWith(APPROVAL_ID, { behavior: 'allow' }, expect.objectContaining({ actorKind: 'telegram' }));
      expect(String(t.sent('editMessageText').at(-1)!.payload.text)).toContain('✅ <b>Ruxsat berildi</b>');
    });

    it('Orqaga asosiy tugmalarni qaytaradi, decide yo\'q', async () => {
      t.bus.publish({ type: 'approval.created', approvalId: APPROVAL_ID });
      await t.flush();
      const ask = t.buttons(t.sent('sendMessage')[0]).find((b) => b.text === '✅ Ruxsat')!;
      await t.bot.handleUpdate(t.press(OWNER, ask.callback_data));
      const back = t.buttons(t.sent('editMessageReplyMarkup').at(-1)).find((b) => b.text === '↩️ Orqaga')!;
      await t.bot.handleUpdate(t.press(OWNER, back.callback_data));
      expect(t.buttons(t.sent('editMessageReplyMarkup').at(-1)).map((b) => b.text)).toEqual(['✅ Ruxsat', '❌ Rad']);
      expect(t.approvals.decide).not.toHaveBeenCalled();
    });

    it('approval.resolved (dashboard/terminal/muddat) -> xabar yakuniy holatga tahrirlanadi, tugmalar olinadi', async () => {
      t.bus.publish({ type: 'approval.created', approvalId: APPROVAL_ID });
      await t.flush();
      t.approvalsState.dto = baseApproval({ status: 'expired', resolvedAt: new Date().toISOString() });
      t.bus.publish({ type: 'approval.resolved', approvalId: APPROVAL_ID });
      await t.flush();
      const edit = t.sent('editMessageText').at(-1)!;
      expect(edit.payload.message_id).toBe(100);
      expect(String(edit.payload.text)).toContain('⌛');
      expect((edit.payload.reply_markup as { inline_keyboard: unknown[] }).inline_keyboard).toEqual([]);
    });

    it('yuborish davomida hal bo\'lib qolgan approval ham yakuniy holatga keltiriladi', async () => {
      let calls = 0;
      t.approvals.getDto.mockImplementation(async () => (++calls <= 1 ? baseApproval() : baseApproval({ status: 'denied' })));
      t.bus.publish({ type: 'approval.created', approvalId: APPROVAL_ID });
      await t.flush();
      expect(String(t.sent('editMessageText').at(-1)?.payload.text)).toContain('❌ <b>Rad etildi</b>');
    });

    it('409 (allaqachon hal qilingan): "Allaqachon hal qilingan" va xabar joriy holatga tahrirlanadi', async () => {
      t.bus.publish({ type: 'approval.created', approvalId: APPROVAL_ID });
      await t.flush();
      t.approvals.decide.mockImplementationOnce(async () => {
        t.approvalsState.dto = baseApproval({ status: 'approved', behavior: 'allow' });
        throw new ConflictException({ error: 'approval_conflict' });
      });
      const deny = t.buttons(t.sent('sendMessage')[0]).find((b) => b.text === '❌ Rad')!;
      await t.bot.handleUpdate(t.press(OWNER, deny.callback_data));
      expect(t.sent('answerCallbackQuery').at(-1)!.payload).toMatchObject({ text: 'Allaqachon hal qilingan', show_alert: true });
      expect(String(t.sent('editMessageText').at(-1)!.payload.text)).toContain('✅ <b>Ruxsat berildi</b>');
    });

    it('lockdown: allow rad etiladi ("Lockdown: faqat rad etish mumkin"), deny ruxsat; tugmalar faqat Rad', async () => {
      t = setup({ lockdown: true });
      await t.service.onApplicationBootstrap();
      t.bus.publish({ type: 'approval.created', approvalId: APPROVAL_ID });
      await t.flush();
      const msg = t.sent('sendMessage')[0]!;
      expect(t.buttons(msg).map((b) => b.text)).toEqual(['❌ Rad']);
      expect(String(msg.payload.text)).toContain('Lockdown');

      // lockdown'dan oldin yuborilgan eski "Ruxsat" tugmasi: ruxsat so'ralmaydi, decide chaqirilmaydi
      const oldAsk = encodeCallback(key, 'ask', APPROVAL_ID, OWNER);
      await t.bot.handleUpdate(t.press(OWNER, oldAsk));
      expect(t.approvals.decide).not.toHaveBeenCalled();
      expect(t.sent('answerCallbackQuery').at(-1)!.payload).toMatchObject({ text: 'Lockdown: faqat rad etish mumkin' });

      // Servis allow'ni 403 qilsa (lockdown oraliqda yoqilgan) ham xuddi shu xabar
      t.approvals.decide.mockRejectedValueOnce(new ForbiddenException({ error: 'lockdown' }));
      await t.bot.handleUpdate(t.press(OWNER, encodeCallback(key, 'confirm', APPROVAL_ID, OWNER)));
      expect(t.sent('answerCallbackQuery').at(-1)!.payload).toMatchObject({ text: 'Lockdown: faqat rad etish mumkin' });

      // deny lockdown'da ruxsat
      await t.bot.handleUpdate(t.press(OWNER, t.buttons(msg)[0]!.callback_data));
      expect(t.approvals.decide).toHaveBeenLastCalledWith(APPROVAL_ID, expect.objectContaining({ behavior: 'deny' }), expect.objectContaining({ actorKind: 'telegram' }));
    });

    it('imzosi noto\'g\'ri callback: decide yo\'q, answerCallbackQuery bor', async () => {
      t.bus.publish({ type: 'approval.created', approvalId: APPROVAL_ID });
      await t.flush();
      const deny = t.buttons(t.sent('sendMessage')[0]).find((b) => b.text === '❌ Rad')!;
      const forged = `${deny.callback_data.slice(0, -1)}${deny.callback_data.endsWith('A') ? 'B' : 'A'}`;
      await t.bot.handleUpdate(t.press(OWNER, forged));
      await t.bot.handleUpdate(t.press(OWNER, 'garbage'));
      expect(t.approvals.decide).not.toHaveBeenCalled();
      expect(t.sent('answerCallbackQuery')).toHaveLength(2);
    });

    it('callback_data bu chatga bog\'langan: boshqa chatning tugmasi ishlamaydi', async () => {
      t = setup({ allowed: [String(OWNER), '5555'] });
      await t.service.onApplicationBootstrap();
      t.bus.publish({ type: 'approval.created', approvalId: APPROVAL_ID });
      await t.flush();
      const forOwner = t.sent('sendMessage').find((c) => c.payload.chat_id === String(OWNER))!;
      const deny = t.buttons(forOwner).find((b) => b.text === '❌ Rad')!;
      expect(decodeCallback(key, deny.callback_data, OWNER)).not.toBeNull();
      await t.bot.handleUpdate(t.press(5555, deny.callback_data));
      expect(t.approvals.decide).not.toHaveBeenCalled();
    });

    it('revoke qilingan telegram identity: qaror berilmaydi', async () => {
      t.access.deviceFor.mockResolvedValueOnce(null as never);
      t.bus.publish({ type: 'approval.created', approvalId: APPROVAL_ID });
      await t.flush();
      const deny = t.buttons(t.sent('sendMessage')[0]).find((b) => b.text === '❌ Rad')!;
      await t.bot.handleUpdate(t.press(OWNER, deny.callback_data));
      expect(t.approvals.decide).not.toHaveBeenCalled();
      expect(t.sent('answerCallbackQuery')).toHaveLength(1);
    });

    it('Telegram API yiqilsa ham bus/center yiqilmaydi', async () => {
      t.bot.api.config.use(async () => {
        throw new Error('network down');
      });
      t.bus.publish({ type: 'approval.created', approvalId: APPROVAL_ID });
      await t.flush();
      expect(t.service).toBeDefined(); // istisno tashqariga chiqmadi
    });

    it('/approvals kutayotganlarni tugmalar bilan beradi', async () => {
      await t.bot.handleUpdate(t.message(OWNER, '/approvals'));
      const msg = t.sent('sendMessage')[0]!;
      expect(t.buttons(msg)).toHaveLength(2);
    });
  });

  describe('bildirishnomalar', () => {
    beforeEach(async () => {
      t = setup();
      await t.service.onApplicationBootstrap();
    });

    const changed = async (status: SessionDto['status']): Promise<void> => {
      t.sessionsSvc.findByRefs.mockResolvedValue([session({ status })]);
      t.bus.publish({ type: 'sessions.changed', refs: [{ machineId: 'm1', claudeSessionId: 's1' }] });
      await t.flush();
    };

    it('working -> waiting bir marta xabar beradi, dublikat va 60 s ichida takror yo\'q', async () => {
      await changed('working');
      await changed('waiting');
      await changed('waiting');
      await changed('working');
      await changed('waiting'); // 60 s oralig'i ichida
      expect(t.sent('sendMessage')).toHaveLength(1);
      expect(String(t.sent('sendMessage')[0]!.payload.text)).toContain('Javobingizni kutmoqda');
    });

    it('offline mashinadagi sessiya uchun xabar yo\'q', async () => {
      t.machines.findById.mockResolvedValue(machine({ online: false }));
      await changed('working');
      await changed('waiting');
      expect(t.sent('sendMessage')).toHaveLength(0);
    });

    it('/mute va /notify done off', async () => {
      await t.bot.handleUpdate(t.message(OWNER, '/mute 30'));
      await changed('working');
      await changed('done');
      expect(t.sent('sendMessage')).toHaveLength(1); // faqat /mute javobi
      await t.bot.handleUpdate(t.message(OWNER, '/mute 0'));
      await t.bot.handleUpdate(t.message(OWNER, '/notify done off'));
      await changed('working');
      await changed('done');
      expect(t.sent('sendMessage')).toHaveLength(3); // + /mute 0, /notify javoblari; done xabari yo'q
      expect(t.access.savePrefs).toHaveBeenLastCalledWith(expect.objectContaining({ notifyDone: false, mutedUntil: 0 }));
    });

    it('/mute noto\'g\'ri qiymat -> foydalanish ko\'rsatmasi', async () => {
      await t.bot.handleUpdate(t.message(OWNER, '/mute abc'));
      expect(String(t.sent('sendMessage')[0]!.payload.text)).toContain('Foydalanish');
      expect(t.access.savePrefs).not.toHaveBeenCalled();
    });

    it('offline > 2 daqiqa: bir marta ogohlantirish; qaytganda bir marta xabar', async () => {
      const now = Date.now();
      t.machines.findById.mockResolvedValue(machine({ online: false }));
      t.bus.publish({ type: 'machine.changed', machineId: 'm1' });
      await t.flush();
      await t.service.checkMachines(now + 60_000);
      expect(t.sent('sendMessage')).toHaveLength(0);
      await t.service.checkMachines(now + 121_000);
      await t.service.checkMachines(now + 200_000);
      expect(t.sent('sendMessage')).toHaveLength(1);
      expect(String(t.sent('sendMessage')[0]!.payload.text)).toContain('offline');
      t.machines.findById.mockResolvedValue(machine({ online: true }));
      t.bus.publish({ type: 'machine.changed', machineId: 'm1' });
      await t.flush();
      expect(t.sent('sendMessage')).toHaveLength(2);
      expect(String(t.sent('sendMessage')[1]!.payload.text)).toContain('qayta ulandi');
    });
  });

  describe('step-up (buyruq tasdig\'i)', () => {
    beforeEach(async () => {
      t = setup();
      await t.service.onApplicationBootstrap();
    });

    it('requestStepUp: egasi chatiga redakt qilingan, HTML-escape qilingan xabar + Tasdiqlash/Bekor tugmalari', async () => {
      const n = await t.service['requestStepUp'](baseCommand());
      expect(n).toBe(1);
      const msg = t.sent('sendMessage')[0]!;
      const text = String(msg.payload.text);
      expect(text).toContain('Tasdiqlang');
      expect(text).toContain('&lt;b&gt;the&lt;/b&gt;');
      expect(text).not.toContain('sk-ant-abcdefghijklmnop');
      expect(t.buttons(msg).map((b) => b.text)).toEqual(['✅ Tasdiqlash', '❌ Bekor']);
    });

    it('Tasdiqlash -> commands.confirm(actor telegram) chaqiriladi va xabar tahrirlanadi', async () => {
      await t.service['requestStepUp'](baseCommand());
      const yes = t.buttons(t.sent('sendMessage')[0]).find((b) => b.text === '✅ Tasdiqlash')!;
      await t.bot.handleUpdate(t.press(OWNER, yes.callback_data));
      expect(t.commands.confirm).toHaveBeenCalledWith(COMMAND_ID, { deviceId: 'telegram-device-1', actorKind: 'telegram', ip: null });
      expect(String(t.sent('editMessageText').at(-1)!.payload.text)).toContain('Tasdiqlandi');
    });

    it('Bekor -> commands.cancel; confirm chaqirilmaydi', async () => {
      await t.service['requestStepUp'](baseCommand());
      const no = t.buttons(t.sent('sendMessage')[0]).find((b) => b.text === '❌ Bekor')!;
      await t.bot.handleUpdate(t.press(OWNER, no.callback_data));
      expect(t.commands.cancel).toHaveBeenCalledTimes(1);
      expect(t.commands.confirm).not.toHaveBeenCalled();
    });

    it('allowlist\'da yo\'q chat tugmani bossa: commands.confirm chaqirilmaydi (HMAC chat id\'ga bog\'langan)', async () => {
      await t.service['requestStepUp'](baseCommand());
      const yes = t.buttons(t.sent('sendMessage')[0]).find((b) => b.text === '✅ Tasdiqlash')!;
      await t.bot.handleUpdate(t.press(STRANGER, yes.callback_data));
      expect(t.commands.confirm).not.toHaveBeenCalled();
    });

    it('command.changed yakuniy holatda: tracked xabar tahrirlanadi', async () => {
      await t.service['requestStepUp'](baseCommand());
      t.commandState.dto = baseCommand({ status: 'expired', errorCode: 'step_up_expired' });
      t.bus.publish({ type: 'command.changed', commandId: COMMAND_ID });
      await t.flush();
      expect(String(t.sent('editMessageText').at(-1)!.payload.text)).toContain('Muddati o');
    });

    it('stepUpAvailable: allowlist bo\'sh bo\'lsa false (hech qachon avtomatik tasdiq emas)', async () => {
      t = setup({ allowed: [] });
      await t.service.onApplicationBootstrap();
      expect(await t.service['stepUpAvailable']()).toBe(false);
    });
  });

  it('token yo\'q: bot o\'chiq, hech narsa ishga tushmaydi', async () => {
    const svc = new TelegramService({ token: null, polling: true, machineOfflineAfterMs: 1, machineGraceMs: 1, machineTickMs: 1, sessionMinGapMs: 1 }, null, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, new RealtimeBus(), {} as never, new StepUpRegistry(), {} as never);
    await expect(svc.onApplicationBootstrap()).resolves.toBeUndefined();
    await expect(svc.beforeApplicationShutdown()).resolves.toBeUndefined();
  });
});

// --- /new, /s, reply-prompt, stop -----------------------------------------------------------------------

const CONTROL = { enabled: true, allowStart: true, allowPrompt: true, allowStop: true, allowSetMode: false, allowAutoMode: false, maxConcurrentStarted: 3, allowedRootCount: 1, centerKeyPinned: true, runningAsRoot: false };
const SESSION_UUID = '7e57c0de-1111-4222-8333-444455556666';
const CLAUDE_SID = 'abcdef12-3456-7890-abcd-ef1234567890';
const PROMPT_ID = '6d1e3b55-2c8f-4a1b-8e42-1f2a3b4c5d6e';
const SECRET_TASK = 'fix the bug; token=sk-ant-abcdefghijklmnop';

const fullSession = (over: Partial<SessionDto> = {}): SessionDto =>
  ({
    id: SESSION_UUID, claudeSessionId: CLAUDE_SID, machineId: 'm1', machineSlug: 'mac-mini', machineName: 'Mac mini', projectId: null, projectName: 'commander', cwd: '/w/commander', name: null, kind: 'bg',
    status: 'working', message: null, notificationType: null, model: 'haiku', permissionMode: 'default', startedAt: new Date().toISOString(), statusSince: new Date().toISOString(), lastSeenAt: new Date().toISOString(),
    endedAt: null, endReason: null, staleSince: null, pendingApprovals: 0, controllable: true, controlReason: null, controls: { prompt: true, stop: true, setMode: false }, ...over,
  }) as SessionDto;

describe('TelegramService /new', () => {
  let t: ReturnType<typeof setup>;
  const startable = (over: Partial<MachineDto> = {}, control: Partial<typeof CONTROL> = {}): MachineDto =>
    machine({ id: 'm1', displayName: 'Mac mini', control: { ...CONTROL, ...control }, ...over } as Partial<MachineDto>);

  const lastId = (): number => 100 + t.sent('sendMessage').length - 1;
  const lastSent = () => t.sent('sendMessage').at(-1)!;
  const lastEdit = () => t.sent('editMessageText').at(-1)!;
  const btn = (call: { payload: Record<string, unknown> } | undefined, label: string): string => {
    const b = t.buttons(call as never).find((x) => x.text.includes(label));
    if (!b) throw new Error(`button "${label}" not found in ${JSON.stringify(t.buttons(call as never).map((x) => x.text))}`);
    return b.callback_data;
  };
  const tap = async (call: { payload: Record<string, unknown> } | undefined, label: string, messageId: number): Promise<void> => {
    await t.bot.handleUpdate(t.press(OWNER, btn(call, label), OWNER, messageId));
    await t.flush();
  };
  const answers = (): string[] => t.sent('answerCallbackQuery').map((c) => String(c.payload.text ?? ''));

  /** /new -> mashina -> papka -> model -> rejim -> vazifa matni: xulosa kartasi xabar id'sini qaytaradi. */
  async function toSummary(opts: { model?: string; mode?: string } = {}): Promise<number> {
    await t.bot.handleUpdate(t.message(OWNER, '/new'));
    await tap(lastSent(), 'Mac mini', lastId());
    const card = lastId();
    await tap(lastEdit(), 'commander', card);
    await tap(lastEdit(), opts.model ?? 'Sonnet', card);
    await tap(lastEdit(), opts.mode ?? 'Qo\'lda', card);
    await t.bot.handleUpdate(t.message(OWNER, SECRET_TASK));
    await t.flush();
    return lastId();
  }

  beforeEach(async () => {
    t = setup();
    t.machines.list.mockImplementation(async () => ({
      items: [
        startable(),
        startable({ id: 'm-off', displayName: 'Offline box', online: false }),
        machine({ id: 'm-nocontrol', displayName: 'No control', control: null } as Partial<MachineDto>),
        startable({ id: 'm-nostart', displayName: 'No start' }, { allowStart: false }),
        startable({ id: 'm-disabled', displayName: 'Disabled' }, { enabled: false }),
      ],
      onlineCount: 4,
    }));
    t.machines.findById.mockImplementation(async () => startable());
    t.commandState.dto = baseCommand({ status: 'sent', permissionMode: 'default', model: 'sonnet', stepUp: { required: false, via: null, expiresAt: null, confirmedAt: new Date().toISOString(), confirmedByDeviceId: 'telegram-device-1' } });
    await t.service.onApplicationBootstrap();
  });

  it('/new: faqat online + control.enabled + allowStart mashinalar tugma bo\'ladi', async () => {
    await t.bot.handleUpdate(t.message(OWNER, '/new'));
    const labels = t.buttons(lastSent()).map((b) => b.text);
    expect(labels).toEqual(['🖥 Mac mini', '❌ Bekor']);
  });

  it('to\'liq oqim: mashina -> papka (oxirgi ishlatilgani birinchi) -> model -> rejim -> matn -> Ochish: create(actor telegram, inline tasdiq), ikkinchi step-up YO\'Q', async () => {
    const stepUpSpy = vi.spyOn(t.stepUp, 'request');
    await t.bot.handleUpdate(t.message(OWNER, '/new'));
    await tap(lastSent(), 'Mac mini', lastId());
    const card = lastId();

    // Papkalar: shu mashinaning loyihalari (boshqa mashinanikisi yo'q), eng yangisi birinchi, + "Boshqa papka"
    expect(t.buttons(lastEdit()).map((b) => b.text)).toEqual(['📁 commander', '📁 old-proj', '✏️ Boshqa papka', '❌ Bekor']);
    await tap(lastEdit(), 'commander', card);
    expect(t.buttons(lastEdit()).map((b) => b.text)).toEqual(['Haiku', 'Sonnet', 'Opus', '❌ Bekor']);
    await tap(lastEdit(), 'Sonnet', card);
    // auto yo'q (allowAutoMode=false)
    expect(t.buttons(lastEdit()).map((b) => b.text)).toEqual(['Qo\'lda', 'Avto tahrir', 'Reja', '❌ Bekor']);
    await tap(lastEdit(), 'Qo\'lda', card);
    expect(lastSent().payload.reply_markup).toMatchObject({ force_reply: true });

    await t.bot.handleUpdate(t.message(OWNER, SECRET_TASK));
    await t.flush();
    const summary = lastSent();
    expect(String(summary.payload.text)).toContain('sonnet');
    expect(String(summary.payload.text)).toContain('/w/commander');
    expect(String(summary.payload.text)).not.toContain('sk-ant-abcdefghijklmnop'); // xulosa redakt
    expect(t.commands.create).not.toHaveBeenCalled();

    await tap(summary, 'Ochish', lastId());
    expect(t.commands.create).toHaveBeenCalledTimes(1);
    const [body, actor, key] = t.commands.create.mock.calls[0] as unknown as [Record<string, unknown>, Record<string, unknown>, string];
    expect(body).toEqual({ type: 'session.start', machineId: 'm1', cwd: '/w/commander', prompt: SECRET_TASK, model: 'sonnet', permissionMode: 'default' });
    expect(actor).toEqual({ deviceId: 'telegram-device-1', actorKind: 'telegram', ip: null, confirmation: 'telegram_inline' });
    expect(key).toMatch(/^tg-new-[0-9a-f-]{36}$/);
    expect(stepUpSpy).not.toHaveBeenCalled();
    expect(t.sent('sendMessage').some((c) => String(c.payload.text).includes('Tasdiqlang'))).toBe(false);

    // Progress: Yuborildi -> Bajarilmoqda -> Sessiya ochildi (xabar tahrirlanadi)
    expect(String(lastEdit().payload.text)).toContain('Yuborildi');
    t.commandState.dto = { ...t.commandState.dto, status: 'running', ackedAt: new Date().toISOString() };
    t.bus.publish({ type: 'command.changed', commandId: COMMAND_ID });
    await t.flush();
    expect(String(lastEdit().payload.text)).toContain('Bajarilmoqda');
    t.commandState.dto = { ...t.commandState.dto, status: 'done', sessionId: SESSION_UUID, claudeSessionId: CLAUDE_SID };
    t.bus.publish({ type: 'command.changed', commandId: COMMAND_ID });
    await t.flush();
    const done = String(lastEdit().payload.text);
    expect(done).toContain('Sessiya ochildi');
    expect(done).toContain('commander');
    expect(done).toContain('Mac mini');
    expect(done).toContain('/s abcdef12');
    expect(t.buttons(lastEdit()).map((b) => b.text)).toEqual(['⏹ To\'xtatish']);
  });

  it('auto rejim: chatda ALOHIDA ikkinchi tasdiq tugmasi shart; shundan keyingina create', async () => {
    t.machines.list.mockImplementation(async () => ({ items: [startable({}, { allowAutoMode: true })], onlineCount: 1 }));
    t.machines.findById.mockImplementation(async () => startable({}, { allowAutoMode: true }));
    await t.bot.handleUpdate(t.message(OWNER, '/new'));
    await tap(lastSent(), 'Mac mini', lastId());
    const card = lastId();
    await tap(lastEdit(), 'commander', card);
    await tap(lastEdit(), 'Opus', card);
    expect(t.buttons(lastEdit()).map((b) => b.text)).toContain('Avto (auto)');
    await tap(lastEdit(), 'Avto (auto)', card);
    await t.bot.handleUpdate(t.message(OWNER, 'do it'));
    await t.flush();
    const summary = lastSent();
    await tap(summary, 'Ochish', lastId());
    expect(t.commands.create).not.toHaveBeenCalled(); // birinchi bosish yetmaydi
    expect(String(lastEdit().payload.text)).toContain('Avto (auto) rejim');
    await tap(lastEdit(), 'Ha, Avto rejimda och', lastId());
    expect(t.commands.create).toHaveBeenCalledTimes(1);
    expect(t.commands.create.mock.calls[0]![0]).toMatchObject({ permissionMode: 'auto', model: 'opus' });
    expect(t.commands.create.mock.calls[0]![1]).toMatchObject({ actorKind: 'telegram', confirmation: 'telegram_inline' });
  });

  it('Ochish ikki marta bosilsa: bitta buyruq', async () => {
    const summary = await toSummary();
    const data = btn(lastSent(), 'Ochish');
    await t.bot.handleUpdate(t.press(OWNER, data, OWNER, summary));
    await t.bot.handleUpdate(t.press(OWNER, data, OWNER, summary));
    await t.flush();
    expect(t.commands.create).toHaveBeenCalledTimes(1);
  });

  it('"Boshqa papka": yo\'l matn bilan so\'raladi, mutlaq bo\'lmagan yo\'l rad etiladi', async () => {
    await t.bot.handleUpdate(t.message(OWNER, '/new'));
    await tap(lastSent(), 'Mac mini', lastId());
    await tap(lastEdit(), 'Boshqa papka', lastId());
    expect(lastSent().payload.reply_markup).toMatchObject({ force_reply: true });
    await t.bot.handleUpdate(t.message(OWNER, 'relative/dir'));
    await t.flush();
    expect(String(lastSent().payload.text)).toContain('mutlaq yo');
    await t.bot.handleUpdate(t.message(OWNER, '/tmp/scratch'));
    await t.flush();
    expect(t.buttons(lastSent()).map((b) => b.text)).toEqual(['Haiku', 'Sonnet', 'Opus', '❌ Bekor']);
    expect(String(lastSent().payload.text)).toContain('/tmp/scratch');
  });

  it('mashina yo\'q: tushuntirish + agentd policy enable', async () => {
    t.machines.list.mockImplementation(async () => ({ items: [machine({ control: null } as Partial<MachineDto>)], onlineCount: 1 }));
    await t.bot.handleUpdate(t.message(OWNER, '/new'));
    const text = String(lastSent().payload.text);
    expect(text).toContain('Hech bir mashinada masofaviy boshqaruv yoqilmagan');
    expect(text).toContain('agentd policy enable');
    expect(t.buttons(lastSent())).toEqual([]);
  });

  it('begona chat: /new va matnga HECH QANDAY javob yo\'q', async () => {
    await t.bot.handleUpdate(t.message(STRANGER, '/new'));
    await t.bot.handleUpdate(t.message(STRANGER, 'hello'));
    await t.flush();
    expect(t.calls).toEqual([]);
    expect(t.commands.create).not.toHaveBeenCalled();
  });

  it('muddati o\'tgan suhbat (10 daqiqa): tugma "tugagan" deydi va create chaqirilmaydi', async () => {
    const summary = await toSummary();
    const real = Date.now();
    const spy = vi.spyOn(Date, 'now').mockReturnValue(real + 11 * 60_000);
    try {
      await t.bot.handleUpdate(t.press(OWNER, btn(lastSent(), 'Ochish'), OWNER, summary));
      await t.flush();
    } finally {
      spy.mockRestore();
    }
    expect(t.commands.create).not.toHaveBeenCalled();
    expect(answers().at(-1)).toContain('muddati tugagan');
  });

  it('noma\'lum ref va boshqa chat uchun imzolangan tugma: ishlamaydi', async () => {
    await t.bot.handleUpdate(t.message(OWNER, '/new'));
    const forged = encodeCallback(key, 'pick', '11111111-1111-4111-8111-111111111111', OWNER);
    await t.bot.handleUpdate(t.press(OWNER, forged, OWNER, lastId()));
    const wrongChat = encodeCallback(key, 'pick', '11111111-1111-4111-8111-111111111111', STRANGER);
    await t.bot.handleUpdate(t.press(OWNER, wrongChat, OWNER, lastId()));
    await t.flush();
    expect(answers().slice(-2)).toEqual(['Tugma eskirgan. /new yoki /s', 'Noto\'g\'ri so\'rov']);
    expect(t.commands.create).not.toHaveBeenCalled();
  });

  it('lockdown: /new "Lockdown: buyruqlar bloklangan"', async () => {
    t.lockdown.state.mockImplementation(async () => ({ enabled: true, since: null }));
    await t.bot.handleUpdate(t.message(OWNER, '/new'));
    expect(String(lastSent().payload.text)).toContain('Lockdown: buyruqlar bloklangan');
    expect(t.buttons(lastSent())).toEqual([]);
  });

  it('/new tezlik chegarasi: 5 tadan keyin rad', async () => {
    for (let i = 0; i < 5; i++) await t.bot.handleUpdate(t.message(OWNER, '/new'));
    await t.bot.handleUpdate(t.message(OWNER, '/new'));
    expect(String(lastSent().payload.text)).toContain('juda tez-tez');
  });

  describe('sessiya ochilgandan keyin', () => {
    let card: number;
    beforeEach(async () => {
      const summary = await toSummary();
      await tap(lastSent(), 'Ochish', summary);
      t.commandState.dto = { ...t.commandState.dto, status: 'done', sessionId: SESSION_UUID, claudeSessionId: CLAUDE_SID };
      t.bus.publish({ type: 'command.changed', commandId: COMMAND_ID });
      await t.flush();
      card = summary;
      t.commands.create.mockClear();
    });

    const replyTo = (text: string, messageId: number): Update => {
      const u = t.message(OWNER, text);
      return { ...u, message: { ...u.message!, reply_to_message: { message_id: messageId, date: 0, chat: { id: OWNER, type: 'private', first_name: 'X' } } } } as Update;
    };

    it('progress xabariga reply: session.prompt (step-up yo\'q, confirmation yo\'q)', async () => {
      t.commandState.dto = baseCommand({ id: PROMPT_ID, type: 'session.prompt', status: 'sent', sessionId: SESSION_UUID, claudeSessionId: CLAUDE_SID, cwd: null, permissionMode: null, model: null, stepUp: { required: false, via: null, expiresAt: null, confirmedAt: null, confirmedByDeviceId: null } });
      await t.bot.handleUpdate(replyTo('davom et: testlarni yurgiz', card));
      await t.flush();
      expect(t.commands.create).toHaveBeenCalledTimes(1);
      const [body, actor] = t.commands.create.mock.calls[0] as unknown as [Record<string, unknown>, Record<string, unknown>];
      expect(body).toEqual({ type: 'session.prompt', sessionId: SESSION_UUID, text: 'davom et: testlarni yurgiz' });
      expect(actor).toEqual({ deviceId: 'telegram-device-1', actorKind: 'telegram', ip: null });
      expect(String(lastEdit().payload.text)).toContain('Yuborildi');
    });

    it('reply bo\'lmagan oddiy matn: hech narsa yuborilmaydi', async () => {
      await t.bot.handleUpdate(t.message(OWNER, 'tasodifiy matn'));
      await t.flush();
      expect(t.commands.create).not.toHaveBeenCalled();
    });

    it('reply-prompt xatolari o\'zbekcha: command_in_flight', async () => {
      t.commands.create.mockRejectedValueOnce(new ConflictException({ error: 'command_in_flight', message: 'x' }));
      await t.bot.handleUpdate(replyTo('yana', card));
      await t.flush();
      expect(String(lastSent().payload.text)).toContain('boshqa buyruq bajarilmoqda');
    });

    it('To\'xtatish: birinchi bosish faqat tasdiq so\'raydi, "Ha" session.stop yuboradi', async () => {
      await tap(lastEdit(), 'To\'xtatish', card);
      expect(t.commands.create).not.toHaveBeenCalled();
      const markup = t.sent('editMessageReplyMarkup').at(-1)!;
      expect(t.buttons(markup).map((b) => b.text)).toEqual(['⏹ Ha, to\'xtat', '↩️ Orqaga']);
      t.commandState.dto = baseCommand({ id: PROMPT_ID, type: 'session.stop', status: 'sent', sessionId: SESSION_UUID, cwd: null, permissionMode: null, model: null, stepUp: { required: false, via: null, expiresAt: null, confirmedAt: null, confirmedByDeviceId: null } });
      await tap(markup, 'Ha, to\'xtat', card);
      expect(t.commands.create).toHaveBeenCalledTimes(1);
      expect(t.commands.create.mock.calls[0]![0]).toEqual({ type: 'session.stop', sessionId: SESSION_UUID });
      expect(t.commands.create.mock.calls[0]![1]).toEqual({ deviceId: 'telegram-device-1', actorKind: 'telegram', ip: null });
    });
  });

  describe('xato kodlari -> o\'zbekcha matn', () => {
    it.each([
      ['policy_disabled', 'masofaviy boshqaruv o\'chiq'],
      ['cwd_not_allowed', 'ruxsat etilgan ro\'yxatda yo\'q'],
      ['machine_offline', 'Mashina oflayn'],
      ['mode_not_allowed', 'siyosatida yoqilmagan'],
    ])('start %s', async (code, expected) => {
      t.commandState.dto = baseCommand({ status: 'rejected', errorCode: code, errorMessage: 'x' });
      const summary = await toSummary();
      await tap(lastSent(), 'Ochish', summary);
      expect(String(lastEdit().payload.text)).toContain(expected);
      expect(t.buttons(lastEdit())).toEqual([]);
    });

    it('agentd keyinroq failed(agent_timeout) qaytarsa: progress xabari yangilanadi', async () => {
      const summary = await toSummary();
      await tap(lastSent(), 'Ochish', summary);
      t.commandState.dto = { ...t.commandState.dto, status: 'failed', errorCode: 'agent_timeout' };
      t.bus.publish({ type: 'command.changed', commandId: COMMAND_ID });
      await t.flush();
      expect(String(lastEdit().payload.text)).toContain('Mashina javob bermadi');
    });
  });

  describe('/s', () => {
    it('ro\'yxat, raqam va id prefiksi; chat matni saqlanmasligi eslatiladi', async () => {
      t.sessionsSvc.list.mockImplementation(async () => ({ items: [fullSession()], nextCursor: null }) as never);
      await t.bot.handleUpdate(t.message(OWNER, '/s'));
      expect(String(lastSent().payload.text)).toContain('abcdef12');
      await t.bot.handleUpdate(t.message(OWNER, '/s 1'));
      const card = String(lastSent().payload.text);
      expect(card).toContain('commander');
      expect(card).toContain('Mac mini');
      expect(card).toContain('dashboard');
      await t.bot.handleUpdate(t.message(OWNER, '/s abcdef12'));
      expect(String(lastSent().payload.text)).toContain('Holat');
      await t.bot.handleUpdate(t.message(OWNER, '/s zzzz'));
      expect(String(lastSent().payload.text)).toContain('Foydalanish');
    });
  });
});


// --- 2.13 avto-ruxsat tugmasi va 2.14 reja ----------------------------------------------------------------

const PLAN_TEXT = '# Reja\n1. <b>Edit</b> src & test\n2. API_TOKEN=S3cr3tV4lue99S3cr3tV4lue99';

describe('avto-ruxsat qoidasi tugmasi (2.13)', () => {
  let t: ReturnType<typeof setup>;
  beforeEach(async () => {
    t = setup();
    await t.service.onApplicationBootstrap();
  });

  it("faqat fayl yozish vositalari va sessiyasi ma'lum so'rov uchun tugma bor (Bash/Read/sessiyasiz: yo'q)", async () => {
    for (const [tool, sessionId, expected] of [
      ['Edit', SESSION_UUID, true],
      ['Write', SESSION_UUID, true],
      ['Bash', SESSION_UUID, false],
      ['Read', SESSION_UUID, false],
      ['Edit', null, false],
    ] as const) {
      t.calls.length = 0;
      t.approvalsState.dto = baseApproval({ toolName: tool, sessionId });
      t.bus.publish({ type: 'approval.created', approvalId: APPROVAL_ID });
      await t.flush();
      const labels = t.buttons(t.sent('sendMessage')[0]).map((b) => b.text);
      expect(labels.some((l) => l.includes('1 soat avto-ruxsat')), `${tool}/${String(sessionId)}`).toBe(expected);
    }
  });

  it("tugma ikki bosqichli: birinchi bosish qoida YARATMAYDI; tasdiqdan keyin session-qoida (telegram, inline) + shu so'rov allow", async () => {
    t.approvalsState.dto = baseApproval({ toolName: 'Edit', sessionId: SESSION_UUID });
    t.bus.publish({ type: 'approval.created', approvalId: APPROVAL_ID });
    await t.flush();
    const rule = t.buttons(t.sent('sendMessage')[0]).find((b) => b.text.includes('avto-ruxsat'))!;
    await t.bot.handleUpdate(t.press(OWNER, rule.callback_data));
    expect(t.rules.create).not.toHaveBeenCalled();
    expect(t.approvals.decide).not.toHaveBeenCalled();
    const confirm = t.buttons(t.sent('editMessageReplyMarkup').at(-1)).find((b) => b.text.startsWith('✅'))!;

    await t.bot.handleUpdate(t.press(OWNER, confirm.callback_data));
    expect(t.rules.create).toHaveBeenCalledWith(
      { scope: 'session', scopeRef: SESSION_UUID, tools: ['Edit', 'Write', 'MultiEdit'], pathGlobs: [], ttlSeconds: 3600 },
      { deviceId: 'telegram-device-1', actorKind: 'telegram', ip: null, confirmation: 'telegram_inline' },
    );
    expect(t.approvals.decide).toHaveBeenCalledWith(APPROVAL_ID, { behavior: 'allow' }, expect.objectContaining({ actorKind: 'telegram' }));
  });

  it("lockdown: qoida tugmasi ko'rsatilmaydi va bosilsa qoida yaratilmaydi", async () => {
    t = setup({ lockdown: true });
    await t.service.onApplicationBootstrap();
    t.approvalsState.dto = baseApproval({ toolName: 'Edit', sessionId: SESSION_UUID });
    t.bus.publish({ type: 'approval.created', approvalId: APPROVAL_ID });
    await t.flush();
    expect(t.buttons(t.sent('sendMessage')[0]).map((b) => b.text)).toEqual(['❌ Rad']);
    // qo'lda yasalgan (imzo to'g'ri) 'rule' callback ham ishlamaydi
    const forged = encodeCallback(key, 'ruleyes', APPROVAL_ID, OWNER);
    await t.bot.handleUpdate(t.press(OWNER, forged));
    expect(t.rules.create).not.toHaveBeenCalled();
  });

  it("qoida yaratilmasa (403 step-up/lockdown) so'rov allow QILINMAYDI", async () => {
    t.approvalsState.dto = baseApproval({ toolName: 'Write', sessionId: SESSION_UUID });
    t.rules.create.mockRejectedValueOnce(new ForbiddenException({ error: 'lockdown' }));
    await t.bot.handleUpdate(t.press(OWNER, encodeCallback(key, 'ruleyes', APPROVAL_ID, OWNER)));
    expect(t.approvals.decide).not.toHaveBeenCalled();
  });

  it("avto-ruxsat bilan hal bo'lgan xabar 'avto-ruxsat (qoida #id)' ko'rsatadi", () => {
    const text = formatApproval(baseApproval({ status: 'approved', behavior: 'allow', autoRuleId: 7, resolvedAt: new Date().toISOString() }));
    expect(text).toContain('Avto-ruxsat');
    expect(text).toContain('qoida #7');
  });
});

describe('reja so\'rovi Telegram\'da (2.14)', () => {
  let t: ReturnType<typeof setup>;
  const planDto = (over: Partial<ApprovalDto> = {}) => baseApproval({ toolName: 'ExitPlanMode', kind: 'plan', plan: PLAN_TEXT, toolInputRedacted: '{"planFilePath":"/p.md"}', ...over });
  beforeEach(async () => {
    t = setup();
    await t.service.onApplicationBootstrap();
    t.approvalsState.dto = planDto();
  });

  it('reja HTML-escape + redakt qilingan, tugmalar: Fikr bilan rad / Rad (tasdiqlash yo\'q: Claude Code allow ni qabul qilmaydi)', async () => {
    t.bus.publish({ type: 'approval.created', approvalId: APPROVAL_ID });
    await t.flush();
    const msg = t.sent('sendMessage')[0]!;
    const text = String(msg.payload.text);
    expect(text).toContain('Reja tasdig');
    expect(text).toContain('&lt;b&gt;Edit&lt;/b&gt; src &amp; test');
    expect(text).not.toContain('S3cr3t');
    expect(text).not.toContain('<b>Edit</b>');
    expect(t.buttons(msg).map((b) => b.text)).toEqual(['✏️ Fikr bilan rad', '❌ Rad']);
  });

  it("uzun reja ~3500 belgigacha kesiladi va dashboard'ga yo'naltiradi; xabar Telegram chegarasidan oshmaydi", () => {
    const text = formatApproval(planDto({ plan: 'x'.repeat(16_000) }));
    expect(text).toContain("to'liq reja dashboard'da");
    expect(Array.from(text).length).toBeLessThan(4096);
    expect(Array.from(text).filter((c) => c === 'x').length).toBeLessThanOrEqual(3500);
  });

  it('reply bilan fikr: deny(message=fikr) chaqiriladi, tugmalar tahrir qilinadi, Claude\'ga yo\'naltirilgan matn qirqiladi', async () => {
    t.bus.publish({ type: 'approval.created', approvalId: APPROVAL_ID });
    await t.flush();
    const planMsgId = 100; // fake API birinchi sendMessage'ga 100 beradi
    t.approvals.decide.mockImplementationOnce(async (..._a: unknown[]) => {
      t.approvalsState.dto = planDto({ status: 'denied', behavior: 'deny', resolvedAt: new Date().toISOString(), decisionMessage: 'Faqat 1 qadam qoldiring' });
      return { approval: t.approvalsState.dto, delivered: true, idempotent: false };
    });
    const upd = t.message(OWNER, "Faqat 1 qadam qoldiring  API_TOKEN=S3cr3tV4lue99S3cr3tV4lue99");
    (upd.message as { reply_to_message?: unknown }).reply_to_message = { message_id: planMsgId, date: 0, chat: { id: OWNER, type: 'private', first_name: 'X' } };
    await t.bot.handleUpdate(upd);
    expect(t.approvals.decide).toHaveBeenCalledTimes(1);
    const [id, body, actor] = t.approvals.decide.mock.calls[0] as unknown as [string, { behavior: string; message: string }, { actorKind: string }];
    expect(id).toBe(APPROVAL_ID);
    expect(body.behavior).toBe('deny');
    expect(body.message).toContain('1 qadam');
    expect(body.message).not.toContain('S3cr3t');
    expect(body.message.length).toBeLessThanOrEqual(1000);
    expect(actor.actorKind).toBe('telegram');
    expect(String(t.sent('editMessageText').at(-1)!.payload.text)).toContain('Reja rad etildi');
  });

  it("'Fikr bilan rad' tugmasi ForceReply so'raydi; shu so'rovga reply fikr bo'ladi", async () => {
    t.bus.publish({ type: 'approval.created', approvalId: APPROVAL_ID });
    await t.flush();
    const fb = t.buttons(t.sent('sendMessage')[0]).find((b) => b.text.startsWith('✏️'))!;
    await t.bot.handleUpdate(t.press(OWNER, fb.callback_data));
    expect(t.approvals.decide).not.toHaveBeenCalled();
    const prompt = t.sent('sendMessage').at(-1)!;
    expect((prompt.payload.reply_markup as { force_reply?: boolean }).force_reply).toBe(true);
    const promptId = 101;
    const upd = t.message(OWNER, 'Testlar ham qo\'shing');
    (upd.message as { reply_to_message?: unknown }).reply_to_message = { message_id: promptId, date: 0, chat: { id: OWNER, type: 'private', first_name: 'X' } };
    await t.bot.handleUpdate(upd);
    expect(t.approvals.decide).toHaveBeenCalledWith(APPROVAL_ID, { behavior: 'deny', message: "Testlar ham qo'shing" }, expect.objectContaining({ actorKind: 'telegram' }));
  });

  it("allaqachon hal bo'lgan rejaga fikr yuborilmaydi; reja bo'lmagan so'rovga fikr yo'q", async () => {
    t.bus.publish({ type: 'approval.created', approvalId: APPROVAL_ID });
    await t.flush();
    t.approvalsState.dto = planDto({ status: 'denied', behavior: 'deny' });
    const upd = t.message(OWNER, 'kech qoldi');
    (upd.message as { reply_to_message?: unknown }).reply_to_message = { message_id: 100, date: 0, chat: { id: OWNER, type: 'private', first_name: 'X' } };
    await t.bot.handleUpdate(upd);
    expect(t.approvals.decide).not.toHaveBeenCalled();
    expect(String(t.sent('sendMessage').at(-1)!.payload.text)).toContain('Allaqachon hal qilingan');
  });

  it("allowlist'da yo'q chatning reply'i fikr bo'lmaydi", async () => {
    t.bus.publish({ type: 'approval.created', approvalId: APPROVAL_ID });
    await t.flush();
    const upd = t.message(STRANGER, 'hujum');
    (upd.message as { reply_to_message?: unknown }).reply_to_message = { message_id: 100, date: 0, chat: { id: STRANGER, type: 'private', first_name: 'X' } };
    await t.bot.handleUpdate(upd);
    expect(t.approvals.decide).not.toHaveBeenCalled();
  });
});


// --- 3.1 navbat: /queue, /new yakuniy variantlar, bashorat ogohlantirishi -----------------------------------

describe('TelegramService navbat (3.1)', () => {
  const queueItem = (over: Record<string, unknown> = {}) => ({
    id: '11111111-1111-4111-8111-111111111111', projectId: null, machineId: 'm1', machineSlug: 'mac-mini', cwd: '/w/commander', promptPreview: 'fix <b>bug</b> token=[REDACTED]', promptLength: 20,
    model: 'sonnet', permissionMode: 'default', name: null, taskKey: null, trigger: { type: 'limit_reset', window: '5h' }, status: 'waiting_trigger', attempts: 0, lastError: null, lastErrorCode: null,
    createdByDeviceId: 'telegram-device-1', confirmation: 'telegram_inline', confirmedAt: new Date().toISOString(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    nextRunAt: '2026-11-13T12:00:00.000Z', lastSessionId: null, lastCommandId: null, runCount: 0, lastRunAt: null, ...over,
  });
  const queue = {
    create: vi.fn(async (..._a: unknown[]) => queueItem()),
    cancel: vi.fn(async (..._a: unknown[]) => queueItem({ status: 'cancelled' })),
    list: vi.fn(async (..._a: unknown[]) => ({ items: [queueItem()] })),
  };
  let t: ReturnType<typeof setup>;
  const CTRL = { enabled: true, allowStart: true, allowPrompt: true, allowStop: true, allowSetMode: false, allowAutoMode: false, maxConcurrentStarted: 3, allowedRootCount: 1, centerKeyPinned: true, runningAsRoot: false };
  const m1 = (control: object = CTRL) => machine({ id: 'm1', displayName: 'Mac mini', control } as Partial<MachineDto>);
  const lastId = (): number => 100 + t.sent('sendMessage').length - 1;
  const lastSent = () => t.sent('sendMessage').at(-1)!;
  const lastEdit = () => t.sent('editMessageText').at(-1)!;
  const btn = (call: { payload: Record<string, unknown> } | undefined, label: string): string => {
    const b = t.buttons(call as never).find((x) => x.text.includes(label));
    if (!b) throw new Error(`button "${label}" not found in ${JSON.stringify(t.buttons(call as never).map((x) => x.text))}`);
    return b.callback_data;
  };
  const tap = async (call: { payload: Record<string, unknown> } | undefined, label: string, messageId: number): Promise<void> => {
    await t.bot.handleUpdate(t.press(OWNER, btn(call, label), OWNER, messageId));
    await t.flush();
  };

  async function toSummary(mode = 'Qo\'lda'): Promise<number> {
    await t.bot.handleUpdate(t.message(OWNER, '/new'));
    await tap(lastSent(), 'Mac mini', lastId());
    const card = lastId();
    await tap(lastEdit(), 'commander', card);
    await tap(lastEdit(), 'Sonnet', card);
    await tap(lastEdit(), mode, card);
    await t.bot.handleUpdate(t.message(OWNER, 'fix the bug; token=sk-ant-abcdefghijklmnop'));
    await t.flush();
    return lastId();
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    t = setup({ queue });
    t.machines.list.mockImplementation(async () => ({ items: [m1({ ...CTRL, allowAutoMode: true })], onlineCount: 1 }));
    t.machines.findById.mockImplementation(async () => m1({ ...CTRL, allowAutoMode: true }));
    await t.service.onApplicationBootstrap();
  });

  it('xulosa kartasi: Hozir / Limit yangilanganda / Tunda (02:00)', async () => {
    await toSummary();
    expect(t.buttons(lastSent()).map((b) => b.text)).toEqual(['✅ Ochish (hozir)', '🕒 Limit yangilanganda', '🌙 Tunda (02:00)', '❌ Bekor']);
  });

  it('Limit yangilanganda: queue.create(limit_reset 5h, telegram inline tasdiq), commands.create YO\'Q, vazifa matni o\'chadi', async () => {
    const summary = await toSummary();
    await tap(lastSent(), 'Limit yangilanganda', summary);
    expect(t.commands.create).not.toHaveBeenCalled();
    expect(queue.create).toHaveBeenCalledTimes(1);
    const [body, actor] = queue.create.mock.calls[0] as unknown as [Record<string, unknown>, Record<string, unknown>];
    expect(body).toMatchObject({ machineId: 'm1', cwd: '/w/commander', prompt: 'fix the bug; token=sk-ant-abcdefghijklmnop', model: 'sonnet', permissionMode: 'default', trigger: { type: 'limit_reset', window: '5h' } });
    expect(actor).toMatchObject({ deviceId: 'telegram-device-1', actorKind: 'telegram', confirmation: 'telegram_inline' });
    const text = String(lastEdit().payload.text);
    expect(text).toContain('Navbatga qo');
    expect(text).not.toContain('sk-ant-abcdefghijklmnop');
  });

  it('Tunda (02:00): at triggeri, keyingi 02:00 Toshkent (21:00 UTC)', async () => {
    const summary = await toSummary();
    await tap(lastSent(), 'Tunda', summary);
    const body = queue.create.mock.calls[0]![0] as { trigger: { type: string; at: string } };
    expect(body.trigger.type).toBe('at');
    expect(new Date(body.trigger.at).getUTCHours()).toBe(21);
    expect(new Date(body.trigger.at).getTime()).toBeGreaterThan(Date.now());
  });

  it('auto rejim: navbatga ham ALOHIDA ikkinchi tasdiq shart', async () => {
    const summary = await toSummary('Avto (auto)');
    await tap(lastSent(), 'Tunda', summary);
    expect(queue.create).not.toHaveBeenCalled();
    expect(String(lastEdit().payload.text)).toContain('Avto (auto) rejim');
    await tap(lastEdit(), 'Ha, Avto rejimda och', summary);
    expect(queue.create).toHaveBeenCalledTimes(1);
    expect(queue.create.mock.calls[0]![0]).toMatchObject({ permissionMode: 'auto' });
    expect(t.commands.create).not.toHaveBeenCalled();
  });

  it('queue.create xato (step_up_required / policy): suhbat saqlanadi, o\'zbekcha xabar', async () => {
    const { UnprocessableEntityException } = await import('@nestjs/common');
    queue.create.mockRejectedValueOnce(new UnprocessableEntityException({ error: 'policy_disabled', message: 'x' }));
    const summary = await toSummary();
    await tap(lastSent(), 'Limit yangilanganda', summary);
    expect(t.sent('answerCallbackQuery').map((c) => String(c.payload.text ?? '')).some((x) => x.includes('yoqilmagan'))).toBe(true);
    await tap(lastSent(), 'Limit yangilanganda', summary); // qayta urinish mumkin
    expect(queue.create).toHaveBeenCalledTimes(2);
  });

  it('lockdown: /new o\'zi bloklaydi, navbat yaratilmaydi', async () => {
    t.lockdown.state.mockImplementation(async () => ({ enabled: true, since: null }));
    await t.bot.handleUpdate(t.message(OWNER, '/new'));
    expect(queue.create).not.toHaveBeenCalled();
  });

  it('/queue: ro\'yxat (HTML-escape, redakt) + bekor tugmasi; bekor = queue.cancel (telegram aktor)', async () => {
    await t.bot.handleUpdate(t.message(OWNER, '/queue'));
    await t.flush();
    const text = String(lastSent().payload.text);
    expect(text).toContain('Navbat');
    expect(text).toContain('fix &lt;b&gt;bug&lt;/b&gt; token=[REDACTED]');
    await t.bot.handleUpdate(t.press(OWNER, btn(lastSent(), '❌ 1'), OWNER, lastId()));
    await t.flush();
    expect(queue.cancel).toHaveBeenCalledWith('11111111-1111-4111-8111-111111111111', { deviceId: 'telegram-device-1', actorKind: 'telegram', ip: null });
  });

  it('allowlist\'da yo\'q chat /queue yuborsa: jim', async () => {
    await t.bot.handleUpdate(t.message(STRANGER, '/queue'));
    expect(t.calls).toEqual([]);
    expect(queue.list).not.toHaveBeenCalled();
  });

  describe('bashorat ogohlantirishi', () => {
    const forecast = { exhaustsAt: new Date(Date.now() + 20 * 60_000).toISOString(), beforeReset: true, resetsAt: new Date(Date.now() + 2 * 3_600_000).toISOString(), ratePctPerHour: 20, basisMinutes: 30, basisWeightedTokens: 1e6, confidence: 'high', source: 'official' };
    const limitsWith = (resetsAt: string) => ({
      current: vi.fn(async () => ({
        computedAt: '', freshSeconds: 180, sevenDay: null,
        fiveHour: { usedPct: 90, resetsAt, observedAt: null, source: 'official', stale: false, ageSeconds: 5, reset: false, observedByMachineId: null, anchor: null, calibration: null, forecast: { ...forecast, resetsAt } },
      })),
    });

    it('30 daqiqada tugaydi: BIR marta (oyna bo\'yicha), reset vaqti bilan; "≈" va taxmin belgisi', async () => {
      const resetsAt = forecast.resetsAt;
      t = setup({ queue, limits: limitsWith(resetsAt) });
      await t.service.onApplicationBootstrap();
      t.bus.publish({ type: 'limits.changed' });
      await t.flush();
      const alerts = t.sent('sendMessage').map((c) => String(c.payload.text)).filter((x) => x.includes('limit ≈'));
      expect(alerts).toHaveLength(1);
      expect(alerts[0]).toContain('Yangilanish:');
      expect(alerts[0]).toContain('taxmin');
      t.bus.publish({ type: 'limits.changed' });
      await t.flush();
      expect(t.sent('sendMessage').map((c) => String(c.payload.text)).filter((x) => x.includes('limit ≈'))).toHaveLength(1);
    });
  });
});

describe('AskUserQuestion Telegram\'da (6.13)', () => {
  let t: ReturnType<typeof setup>;
  const QS = [
    { question: 'Which color?', header: 'Color', options: [{ label: 'Red (Recommended)', description: 'issiq <b>' }, { label: 'Blue', description: '' }], multiSelect: false },
    { question: 'Toppings?', header: 'T', options: [{ label: 'Cheese', description: '' }, { label: 'Ham', description: '' }], multiSelect: true },
  ];
  const qDto = (over: Partial<ApprovalDto> = {}) => baseApproval({ toolName: 'AskUserQuestion', kind: 'question', toolInputRedacted: '', questions: QS, ...over });
  const reply = (upd: ReturnType<typeof setup>['message'] extends (...a: never[]) => infer R ? R : never, id: number) => {
    (upd.message as { reply_to_message?: unknown }).reply_to_message = { message_id: id, date: 0, chat: { id: OWNER, type: 'private', first_name: 'X' } };
    return upd;
  };
  beforeEach(async () => {
    t = setup();
    await t.service.onApplicationBootstrap();
    t.approvalsState.dto = qDto();
    t.bus.publish({ type: 'approval.created', approvalId: APPROVAL_ID });
    await t.flush();
  });

  it('birinchi savol: variantlar bitta tugmadan, (tavsiya) belgisi, Boshqa… va Rad; oddiy "Ruxsat" tugmasi YO\'Q; matn escape', () => {
    const msg = t.sent('sendMessage')[0]!;
    const text = String(msg.payload.text);
    expect(text).toContain('Claude savol bermoqda');
    expect(text).toContain('Savol 1/2');
    expect(text).toContain('Red (tavsiya)');
    expect(text).toContain('issiq &lt;b&gt;');
    expect(t.buttons(msg).map((b) => b.text)).toEqual(['Red (tavsiya)', 'Blue', '✍️ Boshqa…', '❌ Rad']);
    expect(t.approvals.decide).not.toHaveBeenCalled(); // hech narsa avtomatik tanlanmaydi
  });

  it('ketma-ket: 1-savol variant -> 2-savolga o\'tadi (decide yo\'q); multiSelect belgilash + Yuborish -> decide(allow, answers indekslar bilan)', async () => {
    const first = t.buttons(t.sent('sendMessage')[0]).find((b) => b.text === 'Blue')!;
    await t.bot.handleUpdate(t.press(OWNER, first.callback_data));
    expect(t.approvals.decide).not.toHaveBeenCalled();
    const edited = t.sent('editMessageText').at(-1)!;
    expect(String(edited.payload.text)).toContain('Savol 2/2');
    const kb = t.buttons(edited);
    expect(kb.map((b) => b.text)).toEqual(['☐ Cheese', '☐ Ham', '✍️ Boshqa…', '✅ Yuborish', '❌ Rad']);
    await t.bot.handleUpdate(t.press(OWNER, kb[1]!.callback_data)); // Ham
    const kb2 = t.buttons(t.sent('editMessageText').at(-1)!);
    expect(kb2.map((b) => b.text)).toContain('☑ Ham');
    await t.bot.handleUpdate(t.press(OWNER, kb2.find((b) => b.text.startsWith('✅ Yuborish'))!.callback_data));
    expect(t.approvals.decide).toHaveBeenCalledWith(
      APPROVAL_ID,
      { behavior: 'allow', answers: [{ q: 0, picks: [1] }, { q: 1, picks: [1] }] },
      { deviceId: 'telegram-device-1', actorKind: 'telegram', ip: null },
    );
  });

  it('bo\'sh multiSelect "Yuborish" decide qilmaydi', async () => {
    await t.bot.handleUpdate(t.press(OWNER, t.buttons(t.sent('sendMessage')[0])[0]!.callback_data));
    const kb = t.buttons(t.sent('editMessageText').at(-1)!);
    await t.bot.handleUpdate(t.press(OWNER, kb.find((b) => b.text === '✅ Yuborish')!.callback_data));
    expect(t.approvals.decide).not.toHaveBeenCalled();
  });

  it('"Boshqa…": ForceReply, reply matni erkin javob bo\'ladi (redakt qilinadi)', async () => {
    const other = t.buttons(t.sent('sendMessage')[0]).find((b) => b.text.startsWith('✍️'))!;
    await t.bot.handleUpdate(t.press(OWNER, other.callback_data));
    const prompt = t.sent('sendMessage').at(-1)!;
    expect((prompt.payload.reply_markup as { force_reply?: boolean }).force_reply).toBe(true);
    await t.bot.handleUpdate(reply(t.message(OWNER, 'Yashil API_TOKEN=S3cr3tV4lue99S3cr3tV4lue99'), 101));
    expect(t.approvals.decide).not.toHaveBeenCalled(); // 2-savol hali javobsiz
    const edited = String(t.sent('editMessageText').at(-1)!.payload.text);
    expect(edited).toContain('Savol 2/2');
    const kb = t.buttons(t.sent('editMessageText').at(-1)!);
    await t.bot.handleUpdate(t.press(OWNER, kb[0]!.callback_data));
    await t.bot.handleUpdate(t.press(OWNER, t.buttons(t.sent('editMessageText').at(-1)!).find((b) => b.text.startsWith('✅ Yuborish'))!.callback_data));
    const body = (t.approvals.decide.mock.calls[0] as unknown as [string, { answers: Array<{ q: number; other?: string }> }])[1];
    expect(body.answers[0]!.other).toContain('Yashil');
    expect(body.answers[0]!.other).not.toContain('S3cr3t');
  });

  it('lockdown: variant bosilsa javob yuborilmaydi; faqat Rad tugmasi', async () => {
    const lt = setup({ lockdown: true });
    await lt.service.onApplicationBootstrap();
    lt.approvalsState.dto = qDto();
    lt.bus.publish({ type: 'approval.created', approvalId: APPROVAL_ID });
    await lt.flush();
    const msg = lt.sent('sendMessage')[0]!;
    expect(lt.buttons(msg).map((b) => b.text)).toEqual(['❌ Rad']);
    expect(String(msg.payload.text)).toContain('Lockdown');
  });

  it('Rad: decide(deny) oddiy yo\'l bilan', async () => {
    const deny = t.buttons(t.sent('sendMessage')[0]).find((b) => b.text === '❌ Rad')!;
    await t.bot.handleUpdate(t.press(OWNER, deny.callback_data));
    expect(t.approvals.decide).toHaveBeenCalledWith(APPROVAL_ID, { behavior: 'deny', message: expect.any(String) }, expect.objectContaining({ actorKind: 'telegram' }));
  });

  it('yakuniy holat: javoblar xabarda ko\'rinadi, tugmalar yo\'q', () => {
    const text = formatApproval(qDto({ status: 'approved', behavior: 'allow', answers: [{ q: 0, picks: [0] }, { q: 1, picks: [0, 1], other: 'X' }] }));
    expect(text).toContain('Javob berildi');
    expect(text).toContain('Red (tavsiya)');
    expect(text).toContain('Cheese, Ham, X');
  });
});
