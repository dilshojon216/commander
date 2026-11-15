import { HttpException } from '@nestjs/common';
import { InlineKeyboard } from 'grammy';
import { describe, expect, it, vi } from 'vitest';
import type { CommandDto, DeployRunDto } from '@commander/contracts';
import { RealtimeBus } from '../realtime/realtime-bus.js';
import { StepUpRegistry } from '../commands/step-up.js';
import { TelegramService } from './telegram.service.js';
import { callbackKey, decodeCallback } from './callback-data.js';
import type { PickValue } from './new-flow.js';
import { formatCommandStepUp } from './telegram-format.js';
import { deployErrorTextUz, formatDeployFinished, formatDeployStarted, formatRollbackCard } from './telegram-deploy.js';

/** TelegramService'ning 6.5 qismi (deploy): bildirishnomalar, "Rollback" tugmasi, chat ichidagi tasdiq. Bot va servislar soxta. */

const TOKEN = '123456:AAtest-token-for-callback-signing-xxxx';
const CHAT = '5550001';
const PROJECT = 'aaaaaaaa-1111-4222-8333-444455556666';
const CMD = '33333333-1111-4222-8333-444455556666';
const SHA = 'a'.repeat(40);
const HASH = 'b'.repeat(64);

const summary = (over: Record<string, unknown> = {}) => ({
  kind: 'run', target: 'prod', commit: SHA, recipeHash: HASH, outcome: 'success', failedPhase: null, failedStep: null,
  steps: [{ phase: 'steps', name: 'build', status: 'ok', exitCode: 0, durationMs: 5 }], health: { ok: true, attempts: 2, lastStatus: 200 }, rollbackDefined: true, durationMs: 42_000, outputTruncated: false, ...over,
});
const run = (over: Partial<DeployRunDto> = {}): DeployRunDto => ({
  commandId: CMD, kind: 'run', target: 'prod', commit: SHA, recipeHash: HASH, status: 'done', errorCode: null, errorMessage: null,
  summary: summary() as DeployRunDto['summary'], requestedByDeviceId: '22222222-1111-4222-8333-444455556666', createdAt: '2026-11-14T10:00:00.000Z', finishedAt: null, ...over,
});

interface ApiCall { method: string; args: unknown[] }

function setup(over: { lockdown?: boolean; device?: string | null; run?: DeployRunDto; rollback?: () => Promise<unknown> } = {}) {
  const calls: ApiCall[] = [];
  const api = new Proxy({}, { get: (_t, method: string) => async (...args: unknown[]) => { calls.push({ method, args }); return { message_id: 900 + calls.length }; } });
  const dto = { id: CMD, machineId: 'm-1', status: 'sent', errorCode: null, result: null } as unknown as CommandDto;
  const deployApi = {
    rollbackContext: vi.fn(async () => ({ projectId: PROJECT, projectName: 'My <App>', run: over.run ?? run() })),
    rollback: vi.fn(over.rollback ?? (async () => ({ command: { ...dto, id: 'rb-1', status: 'awaiting_confirmation', errorCode: null }, idempotent: false }))),
  };
  const commands = { getDto: vi.fn(async () => dto) };
  const svc = new TelegramService(
    { token: TOKEN, polling: false, machineOfflineAfterMs: 1, machineGraceMs: 1, machineTickMs: 3_600_000, sessionMinGapMs: 1 },
    { api } as never,
    { deviceFor: vi.fn(async () => (over.device === undefined ? 'tg-device' : over.device)), allowedIds: vi.fn(async () => new Set([CHAT])) } as never,
    {} as never, { findName: vi.fn(async () => 'ubuntu-1') } as never, {} as never, {} as never, {} as never,
    { state: vi.fn(async () => ({ enabled: over.lockdown === true })) } as never,
    {} as never,
    new RealtimeBus(),
    commands as never,
    new StepUpRegistry(),
    {} as never,
    undefined, undefined, undefined, undefined,
    deployApi as never,
  );
  const priv = svc as unknown as {
    onDeployNotice(n: { kind: 'started' | 'finished'; commandId: string }): Promise<void>;
    handleDeployPick(chatId: string, messageId: number, v: PickValue, answer: (t?: string, a?: boolean) => Promise<void>): Promise<void>;
    picks: { resolve(chatId: string, ref: string, now: number): { value: PickValue } | null };
    machineName(id: string): Promise<string>;
  };
  priv.machineName = async () => 'ubuntu-1';
  const answers: Array<[string | undefined, boolean | undefined]> = [];
  const answer = async (t?: string, a?: boolean): Promise<void> => void answers.push([t, a]);
  const key = callbackKey(TOKEN);
  const pickOf = (cb: string): PickValue => priv.picks.resolve(CHAT, decodeCallback(key, cb, CHAT)!.approvalId, Date.now())!.value;
  return { svc, priv, calls, deployApi, answers, answer, pickOf, of: (m: string) => calls.filter((c) => c.method === m) };
}

const markup = (c: ApiCall): Array<{ text: string; callback_data: string }> => {
  const rm = (c.args[2] as { reply_markup?: InlineKeyboard }).reply_markup;
  return rm ? rm.inline_keyboard.flat().map((b) => ({ text: b.text, callback_data: (b as { callback_data: string }).callback_data })) : [];
};

describe('deploy matnlari (faqat nomlar/holatlar; HTML-escape)', () => {
  it('boshlandi/tugadi/rollback kartasi: maqsad, commit va xesh qisqartmasi; loyiha nomi escape; chiqish matni yo\'q', () => {
    const ctx = { projectName: 'My <App>', machineName: 'ubuntu-1' };
    const started = formatDeployStarted(run(), ctx);
    expect(started).toContain('Deploy boshlandi');
    expect(started).toContain('My &lt;App&gt;');
    expect(started).toContain('aaaaaaaa');
    expect(started).toContain('bbbbbbbb');
    const ok = formatDeployFinished(run(), ctx);
    expect(ok).toContain('✅ muvaffaqiyatli');
    expect(ok).toContain('42 s');
    const rb = formatDeployFinished(run({ status: 'failed', errorCode: 'deploy_failed', summary: summary({ outcome: 'rolled_back', failedPhase: 'steps', failedStep: 'build' }) as DeployRunDto['summary'] }), ctx);
    expect(rb).toContain('avtomatik rollback');
    expect(rb).toContain('build');
    expect(formatDeployFinished(run({ status: 'failed', summary: summary({ outcome: 'rollback_failed', failedPhase: 'health', failedStep: 'health check' }) as DeployRunDto['summary'] }), ctx)).toContain('ROLLBACK HAM MUVAFFAQIYATSIZ');
    expect(formatDeployFinished(run({ kind: 'rollback', summary: summary({ kind: 'rollback', outcome: 'rolled_back' }) as DeployRunDto['summary'] }), ctx)).toContain('Rollback:');
    expect(formatDeployFinished(run({ status: 'rejected', errorCode: 'shell_not_allowed', summary: null }), ctx)).toContain('shell');
    const card = formatRollbackCard(run(), ctx);
    expect(card).toContain('aaaaaaaa');
    expect(card).toContain('bbbbbbbb');
    expect(deployErrorTextUz('commit_changed')).toContain('commit');
    expect(deployErrorTextUz('???')).toBe('Bajarilmadi');
  });
});

describe('Telegram: deploy bildirishnomalari', () => {
  it('started: tugmasiz xabar; finished (rollback bor): "Rollback" tugmasi, callback_data imzolangan (<= 64 bayt); bir (tur, buyruq) uchun BIR marta', async () => {
    const t = setup();
    await t.priv.onDeployNotice({ kind: 'started', commandId: CMD });
    expect(t.of('sendMessage')).toHaveLength(1);
    expect(markup(t.of('sendMessage')[0]!)).toEqual([]);
    await t.priv.onDeployNotice({ kind: 'started', commandId: CMD }); // takror: yo'q
    expect(t.of('sendMessage')).toHaveLength(1);
    await t.priv.onDeployNotice({ kind: 'finished', commandId: CMD });
    const fin = t.of('sendMessage')[1]!;
    const btns = markup(fin);
    expect(btns.map((b) => b.text)).toEqual(['↩️ Rollback']);
    expect(Buffer.byteLength(btns[0]!.callback_data)).toBeLessThanOrEqual(64);
    expect(t.pickOf(btns[0]!.callback_data)).toEqual({ kind: 'deploy_rb_ask', commandId: CMD });
    expect(fin.args[1]).toContain('✅ muvaffaqiyatli');
  });

  it('Rollback tugmasi yo\'q: retseptda rollback yo\'q, avtomatik rollback bajarilgan, yoki bu o\'zi rollback', async () => {
    for (const r of [
      run({ summary: summary({ rollbackDefined: false }) as DeployRunDto['summary'] }),
      run({ status: 'failed', summary: summary({ outcome: 'rolled_back', failedPhase: 'steps', failedStep: 'x' }) as DeployRunDto['summary'] }),
      run({ kind: 'rollback', summary: summary({ kind: 'rollback', outcome: 'rolled_back' }) as DeployRunDto['summary'] }),
      run({ status: 'rejected', summary: null }),
    ]) {
      const t = setup({ run: r });
      await t.priv.onDeployNotice({ kind: 'finished', commandId: CMD });
      expect(t.of('sendMessage')).toHaveLength(1);
      expect(markup(t.of('sendMessage')[0]!)).toEqual([]);
    }
  });

  it('deploy servisi yo\'q (testlar/o\'chiq) yoki buyruq topilmasa: jim', async () => {
    const t = setup();
    t.deployApi.rollbackContext.mockResolvedValueOnce(null as never);
    await t.priv.onDeployNotice({ kind: 'finished', commandId: CMD });
    expect(t.of('sendMessage')).toHaveLength(0);
  });
});

describe('Telegram: Rollback (chat ichidagi tasdiq)', () => {
  it('ask: karta (maqsad/commit/xesh) + "Ha"/"Bekor" tugmalari; hali rollback so\'ralmaydi', async () => {
    const t = setup();
    await t.priv.handleDeployPick(CHAT, 50, { kind: 'deploy_rb_ask', commandId: CMD }, t.answer);
    expect(t.deployApi.rollback).not.toHaveBeenCalled();
    const card = t.of('sendMessage')[0]!;
    expect(card.args[1]).toContain('Rollback');
    expect(card.args[1]).toContain('aaaaaaaa');
    const btns = markup(card);
    expect(btns.map((b) => b.text)).toEqual(['✅ Ha, rollback', '❌ Bekor']);
    expect(t.pickOf(btns[0]!.callback_data)).toEqual({ kind: 'deploy_rb_yes', commandId: CMD });
    expect(t.pickOf(btns[1]!.callback_data)).toEqual({ kind: 'deploy_rb_no' });
  });

  it('yes: rollback (target, commit, xesh) chat ichidagi tasdiq (`telegram_inline`) bilan so\'raladi; karta yangilanadi', async () => {
    const t = setup();
    await t.priv.handleDeployPick(CHAT, 51, { kind: 'deploy_rb_yes', commandId: CMD }, t.answer);
    expect(t.deployApi.rollback).toHaveBeenCalledTimes(1);
    const args = t.deployApi.rollback.mock.calls[0] as unknown as [string, unknown, Record<string, unknown>, string];
    expect(args[0]).toBe(PROJECT);
    expect(args[1]).toEqual({ target: 'prod', recipeHash: HASH, commit: SHA });
    expect(args[2]).toMatchObject({ deviceId: 'tg-device', actorKind: 'telegram', confirmation: 'telegram_inline' });
    expect(args[3]).toMatch(/^tg-rb-33333333-/);
    expect(t.answers.at(-1)).toEqual(['✅ Yuborildi', undefined]);
    expect(t.of('editMessageText').at(-1)!.args[2]).toContain('Yuborildi');
  });

  it('no: bekor; lockdown/ruxsatsiz chat/rollback yo\'q: hech narsa so\'ralmaydi', async () => {
    const t = setup();
    await t.priv.handleDeployPick(CHAT, 52, { kind: 'deploy_rb_no' }, t.answer);
    expect(t.deployApi.rollback).not.toHaveBeenCalled();
    expect(t.of('editMessageText')[0]!.args[2]).toContain('Bekor');
    const lock = setup({ lockdown: true });
    await lock.priv.handleDeployPick(CHAT, 53, { kind: 'deploy_rb_yes', commandId: CMD }, lock.answer);
    expect(lock.deployApi.rollback).not.toHaveBeenCalled();
    expect(lock.answers.at(-1)![1]).toBe(true);
    const nodev = setup({ device: null });
    await nodev.priv.handleDeployPick(CHAT, 54, { kind: 'deploy_rb_yes', commandId: CMD }, nodev.answer);
    expect(nodev.deployApi.rollback).not.toHaveBeenCalled();
    const norb = setup({ run: run({ summary: summary({ rollbackDefined: false }) as DeployRunDto['summary'] }) });
    await norb.priv.handleDeployPick(CHAT, 55, { kind: 'deploy_rb_yes', commandId: CMD }, norb.answer);
    expect(norb.deployApi.rollback).not.toHaveBeenCalled();
    expect(norb.answers.at(-1)![1]).toBe(true);
  });

  it('markaz rad etsa (HTTP xato): o\'zbekcha sabab; rate limit', async () => {
    const t = setup({ rollback: async () => { throw new HttpException({ error: 'commit_changed' }, 409); } });
    await t.priv.handleDeployPick(CHAT, 56, { kind: 'deploy_rb_yes', commandId: CMD }, t.answer);
    expect(t.answers.at(-1)![0]).toContain('commit');
    expect(t.answers.at(-1)![1]).toBe(true);
    const rl = setup({ rollback: async () => { throw new HttpException({ error: 'rate_limited' }, 429); } });
    await rl.priv.handleDeployPick(CHAT, 57, { kind: 'deploy_rb_yes', commandId: CMD }, rl.answer);
    expect(rl.answers.at(-1)![0]).toContain('Juda ko\'p');
  });
});

describe('step-up kartasi (deploy)', () => {
  const cmd = (over: Record<string, unknown> = {}): CommandDto =>
    ({ id: CMD, type: 'deploy.run', status: 'awaiting_confirmation', machineId: 'm-1', machineSlug: 'ubuntu-1', cwd: '/srv/app', permissionMode: null, model: null, promptLength: 80, promptPreview: 'deploy prod @ aaaaaaaa (recipe bbbbbbbb)\nsteps:\n  1. build: npm run build', stepUp: { required: true, via: 'telegram', expiresAt: '2026-11-14T10:02:00.000Z', confirmedAt: null, confirmedByDeviceId: null }, expiresAt: '2026-11-14T10:02:00.000Z', errorCode: null, ...over }) as unknown as CommandDto;
  it('sarlavha DEPLOY, papka, maqsad/commit/xesh va qadam buyruqlari ko\'rinadi; review.required bo\'lsa faqat dashboard', () => {
    const t = formatCommandStepUp(cmd(), 'ubuntu-1');
    expect(t).toContain('DEPLOY');
    expect(t).toContain('/srv/app');
    expect(t).toContain('deploy prod @ aaaaaaaa');
    expect(t).toContain('npm run build');
    const rev = formatCommandStepUp(cmd({ review: { required: true, reasons: ['Deploy rejasi 900 belgi'] } }), 'ubuntu-1');
    expect(rev).toContain('faqat dashboard');
    expect(formatCommandStepUp(cmd({ type: 'git.checkpoint_restore', promptPreview: 'x' }), 'm')).toContain('Checkpoint');
  });
});
