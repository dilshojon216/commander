import { HttpException } from '@nestjs/common';
import { InlineKeyboard } from 'grammy';
import { describe, expect, it, vi } from 'vitest';
import type { CommandDto, DiffResponse } from '@commander/contracts';
import { RealtimeBus } from '../realtime/realtime-bus.js';
import { StepUpRegistry } from '../commands/step-up.js';
import { TelegramService } from './telegram.service.js';
import { callbackKey, decodeCallback } from './callback-data.js';
import type { PickValue } from './new-flow.js';

/** TelegramService'ning 3.5 qismi (Git/PR): tugmalar, diff statistikasi, chat ichidagi PR tasdig'i. Bot va servislar soxta. */

const TOKEN = '123456:AAtest-token-for-callback-signing-xxxx';
const CHAT = '5550001';
const SESSION = '7e57c0de-1111-4222-8333-444455556666';
const PROJECT = 'aaaaaaaa-1111-4222-8333-444455556666';

const DIFF: DiffResponse = {
  projectId: PROJECT,
  sessionId: SESSION,
  commandId: '11111111-1111-4222-8333-444455556666',
  baseSource: 'session_start',
  diff: {
    base: 'abc1234',
    baseSha: 'a'.repeat(40),
    headSha: 'b'.repeat(40),
    branch: 'feat/3.5-x',
    files: [{ path: 'src/a.ts', oldPath: null, status: 'modified', additions: 3, deletions: 1, binary: false, patch: null, truncated: false, hidden: 'stat_only' }],
    filesTotal: 1,
    totalAdditions: 3,
    totalDeletions: 1,
    untracked: [],
    untrackedTotal: 0,
    bytes: 0,
    truncated: false,
  },
};

const ctxBase = { startedBy: 'remote', projectId: PROJECT, projectName: 'commander', branch: 'feat/3.5-x', sessionName: null, taskKey: '3.5', taskTitle: 'Git/PR', commitSubjects: ['feat: diff'] };

interface ApiCall { method: string; args: unknown[] }

function setup(over: { lockdown?: boolean; git?: Record<string, unknown>; device?: string | null } = {}) {
  const calls: ApiCall[] = [];
  const api = new Proxy({}, { get: (_t, method: string) => async (...args: unknown[]) => { calls.push({ method, args }); return { message_id: 900 + calls.length }; } });
  const bot = { api } as never;
  const dto = { id: '22222222-1111-4222-8333-444455556666', status: 'sent', errorCode: null, result: null } as unknown as CommandDto;
  const git = {
    prContextForSession: vi.fn(async () => ({ ...ctxBase })),
    diffForSession: vi.fn(async () => DIFF),
    openPr: vi.fn(async () => ({ command: dto, idempotent: false })),
    projectName: vi.fn(async () => 'commander'),
    ...over.git,
  };
  const commands = { getDto: vi.fn(async () => dto) };
  const svc = new TelegramService(
    { token: TOKEN, polling: false, machineOfflineAfterMs: 1, machineGraceMs: 1, machineTickMs: 3_600_000, sessionMinGapMs: 1 },
    bot,
    { deviceFor: vi.fn(async () => (over.device === undefined ? 'tg-device' : over.device)), allowedIds: vi.fn(async () => new Set([CHAT])) } as never,
    {} as never, {} as never, {} as never, {} as never, {} as never,
    { state: vi.fn(async () => ({ enabled: over.lockdown === true })) } as never,
    {} as never,
    new RealtimeBus(),
    commands as never,
    new StepUpRegistry(),
    {} as never,
    undefined, undefined, undefined,
    git as never,
  );
  const priv = svc as unknown as {
    gitDoneKeyboard(sid: string, pid: string | null): Promise<((chatId: string) => InlineKeyboard) | null>;
    handleGitPick(chatId: string, messageId: number, v: PickValue, answer: (t?: string, a?: boolean) => Promise<void>): Promise<void>;
    renderGitProgress(id: string): Promise<void>;
    gitProgress: Map<string, unknown>;
    picks: { resolve(chatId: string, ref: string, now: number): { value: PickValue } | null };
    onCiFailed(n: unknown): Promise<void>;
  };
  const answers: Array<[string | undefined, boolean | undefined]> = [];
  const answer = async (t?: string, a?: boolean): Promise<void> => void answers.push([t, a]);
  const key = callbackKey(TOKEN);
  const pickOf = (cb: string): PickValue => {
    const d = decodeCallback(key, cb, CHAT)!;
    return priv.picks.resolve(CHAT, d.approvalId, Date.now())!.value;
  };
  return { svc, priv, calls, git, commands, dto, answers, answer, pickOf, of: (m: string) => calls.filter((c) => c.method === m) };
}

const buttons = (kb: InlineKeyboard): Array<{ text: string; callback_data: string }> => kb.inline_keyboard.flat().map((b) => ({ text: b.text, callback_data: (b as { callback_data: string }).callback_data }));

describe('Telegram: sessiya tugagach Diff / PR ochish tugmalari', () => {
  it('Commander ochgan (remote) va loyihali sessiyada ikkita tugma; callback_data imzolangan ref', async () => {
    const t = setup();
    const mk = await t.priv.gitDoneKeyboard(SESSION, PROJECT);
    expect(mk).not.toBeNull();
    const btns = buttons(mk!(CHAT));
    expect(btns.map((b) => b.text)).toEqual(['📄 Diff', '🔀 PR ochish']);
    expect(t.pickOf(btns[0]!.callback_data)).toEqual({ kind: 'git_diff', sessionId: SESSION });
    expect(t.pickOf(btns[1]!.callback_data)).toEqual({ kind: 'git_pr', sessionId: SESSION });
    for (const b of btns) expect(Buffer.byteLength(b.callback_data)).toBeLessThanOrEqual(64);
  });

  it('lokal (remote emas) sessiya yoki loyihasiz sessiya yoki git servisi yo\'q: tugma yo\'q', async () => {
    expect(await setup({ git: { prContextForSession: vi.fn(async () => ({ ...ctxBase, startedBy: 'local' })) } }).priv.gitDoneKeyboard(SESSION, PROJECT)).toBeNull();
    expect(await setup().priv.gitDoneKeyboard(SESSION, null)).toBeNull();
    expect(await setup({ git: { prContextForSession: vi.fn(async () => null) } }).priv.gitDoneKeyboard(SESSION, PROJECT)).toBeNull();
    expect(await setup({ git: { prContextForSession: vi.fn(async () => { throw new Error('db'); }) } }).priv.gitDoneKeyboard(SESSION, PROJECT)).toBeNull();
  });
});

describe('Telegram: Diff tugmasi (faqat statistika)', () => {
  it('statOnly diff so\'raladi; xabarda fayl nomi va +/-; patch yo\'q', async () => {
    const t = setup();
    await t.priv.handleGitPick(CHAT, 50, { kind: 'git_diff', sessionId: SESSION }, t.answer);
    expect(t.git.diffForSession).toHaveBeenCalledWith(SESSION, { statOnly: true }, { deviceId: 'tg-device', actorKind: 'telegram', ip: null });
    const msg = t.of('sendMessage')[0]!;
    const text = msg.args[1] as string;
    expect(text).toContain('src/a.ts');
    expect(text).toContain('+3');
    expect(text).toContain('sessiya boshidan');
  });

  it('xato: HttpException kodi o\'zbekcha ogohlantirishga', async () => {
    const t = setup({ git: { diffForSession: vi.fn(async () => { throw new HttpException({ error: 'machine_offline' }, 409); }) } });
    await t.priv.handleGitPick(CHAT, 50, { kind: 'git_diff', sessionId: SESSION }, t.answer);
    expect(t.answers.at(-1)).toEqual(['Mashina offline', true]);
    expect(t.of('sendMessage')).toHaveLength(0);
  });

  it('lockdown va ruxsatsiz chat: hech narsa so\'ralmaydi', async () => {
    const lock = setup({ lockdown: true });
    await lock.priv.handleGitPick(CHAT, 50, { kind: 'git_diff', sessionId: SESSION }, lock.answer);
    expect(lock.git.diffForSession).not.toHaveBeenCalled();
    expect(lock.answers.at(-1)![1]).toBe(true);
    const nodev = setup({ device: null });
    await nodev.priv.handleGitPick(CHAT, 50, { kind: 'git_pr_yes', sessionId: SESSION }, nodev.answer);
    expect(nodev.git.openPr).not.toHaveBeenCalled();
  });
});

describe('Telegram: PR ochish (chat ichidagi tasdiq)', () => {
  it('"PR ochish" kartasi PR YARATMAYDI: faqat tasdiq/bekor tugmalari', async () => {
    const t = setup();
    await t.priv.handleGitPick(CHAT, 50, { kind: 'git_pr', sessionId: SESSION }, t.answer);
    expect(t.git.openPr).not.toHaveBeenCalled();
    const card = t.of('sendMessage')[0]!;
    expect(card.args[1] as string).toContain('[3.5] Git/PR');
    expect(card.args[1] as string).toContain('feat/3.5-x');
    const kb = (card.args[2] as { reply_markup: InlineKeyboard }).reply_markup;
    expect(buttons(kb).map((b) => b.text)).toEqual(['✅ PR ochish', '❌ Bekor']);
    expect(t.pickOf(buttons(kb)[0]!.callback_data)).toEqual({ kind: 'git_pr_yes', sessionId: SESSION });
  });

  it('tasdiq: openPr(actor telegram + confirmation=telegram_inline), idempotentlik kaliti; progress kartasi yangilanadi', async () => {
    const t = setup();
    await t.priv.handleGitPick(CHAT, 77, { kind: 'git_pr_yes', sessionId: SESSION }, t.answer);
    expect(t.git.openPr).toHaveBeenCalledTimes(1);
    const [projectId, body, actor, key] = t.git.openPr.mock.calls[0] as unknown as [string, Record<string, unknown>, Record<string, unknown>, string];
    expect(projectId).toBe(PROJECT);
    expect(body).toMatchObject({ title: '[3.5] Git/PR', base: 'main', draft: false, head: 'feat/3.5-x' });
    expect(String(body['body'])).toContain('feat: diff');
    expect(actor).toMatchObject({ deviceId: 'tg-device', actorKind: 'telegram', confirmation: 'telegram_inline' });
    expect(key).toMatch(/^tg-pr-7e57c0de-\d+$/);
    expect(t.of('editMessageReplyMarkup')).toHaveLength(1); // tugmalar olib tashlandi
    expect(t.priv.gitProgress.has(t.dto.id)).toBe(true);
    expect(t.of('editMessageText').length).toBeGreaterThan(0);

    // natija kelganda URL ko'rsatiladi va kuzatuv to'xtaydi
    (t.dto as unknown as Record<string, unknown>)['status'] = 'done';
    (t.dto as unknown as Record<string, unknown>)['result'] = { pr: { url: 'https://github.com/a/b/pull/9', number: 9, existing: false } };
    await t.priv.renderGitProgress(t.dto.id);
    expect(t.of('editMessageText').at(-1)!.args[2] as string).toContain('#9');
    expect(t.priv.gitProgress.has(t.dto.id)).toBe(false);
  });

  it('bekor tugmasi: PR yaratilmaydi', async () => {
    const t = setup();
    await t.priv.handleGitPick(CHAT, 50, { kind: 'git_pr_no' }, t.answer);
    expect(t.git.openPr).not.toHaveBeenCalled();
    expect(t.of('editMessageText')).toHaveLength(1);
  });

  it('markaz rad etsa (409 gh_unavailable): ogohlantirish, progress yo\'q', async () => {
    const t = setup({ git: { openPr: vi.fn(async () => { throw new HttpException({ error: 'command_in_flight' }, 409); }) } });
    await t.priv.handleGitPick(CHAT, 50, { kind: 'git_pr_yes', sessionId: SESSION }, t.answer);
    expect(t.answers.at(-1)).toEqual(['Shu loyiha uchun boshqa PR buyrug\'i bajarilmoqda', true]);
    expect(t.priv.gitProgress.size).toBe(0);
  });
});

describe('Telegram: CI xatosi bildirishnomasi', () => {
  it('Commander ochgan PR uchun xabar yuboriladi (loyiha nomi, nomlar, havola)', async () => {
    const t = setup();
    await t.priv.onCiFailed({ projectId: PROJECT, branch: 'feat/3.5-x', prNumber: 42, prUrl: 'https://github.com/a/b/pull/42', runName: 'CI', runUrl: null, failing: ['build'] });
    const text = t.of('sendMessage')[0]!.args[1] as string;
    expect(text).toContain('CI muvaffaqiyatsiz');
    expect(text).toContain('commander');
    expect(text).toContain('PR #42');
  });
});
