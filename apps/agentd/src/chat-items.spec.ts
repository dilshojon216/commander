import { describe, expect, it } from 'vitest';
import { assistant, line, system, text, thinking, toolResult, toolUse, userBlocks, userPrompt } from '../test/chat-fixtures.js';
import { capBytes, ChatItemConverter, isSensitivePath, isSensitiveToolUse, summarizeToolUse } from './chat-items.js';

const conv = (includeThinking = false) => new ChatItemConverter({ includeThinking });
const run = (c: ChatItemConverter, ...entries: unknown[]) => entries.flatMap((e) => c.convertLine(line(e)).items);

describe('user yozuvlari', () => {
  it('oddiy prompt, system-reminder kesiladi', () => {
    const items = run(conv(), userPrompt('salom <system-reminder>ichki</system-reminder> dunyo'));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'user', text: 'salom  dunyo' });
  });

  it('meta, compact summary va sidechain yozuvlari tashlanadi', () => {
    expect(run(conv(), userPrompt('x', 1, { isMeta: true }))).toHaveLength(0);
    expect(run(conv(), userPrompt('x', 1, { isCompactSummary: true }))).toHaveLength(0);
    expect(run(conv(), userPrompt('x', 1, { isSidechain: true }))).toHaveLength(0);
  });

  it('interrupted, /command va fon vazifa bildirishnomasi', () => {
    const items = run(
      conv(),
      userPrompt('[Request interrupted by user]'),
      userPrompt('<command-name>/compact</command-name><command-args>fokus</command-args>'),
      userPrompt('<task-notification><summary>Build tugadi</summary></task-notification>'),
      userPrompt('<local-command-stdout>chiqish</local-command-stdout>'),
    );
    expect(items.map((i) => i.kind)).toEqual(['notice', 'user', 'user']);
    expect(items[0]).toMatchObject({ code: 'interrupted' });
    expect(items[1]).toMatchObject({ variant: 'command', text: '/compact fokus' });
    expect(items[2]).toMatchObject({ variant: 'task', text: 'Build tugadi' });
  });

  it('blok massividagi text va tool_result', () => {
    const c = conv();
    run(c, assistant([toolUse('toolu_1', 'Bash', { command: 'ls -la' })]));
    const items = run(c, userBlocks([{ type: 'text', text: 'savol' }, { type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: 'fayllar' }] }]));
    expect(items[0]).toMatchObject({ kind: 'user', text: 'savol' });
    expect(items[1]).toMatchObject({ kind: 'tool_result', toolUseId: 'toolu_1', toolName: 'Bash', ok: true, text: 'fayllar', truncated: false });
  });
});

describe('assistant yozuvlari', () => {
  it('bir so\'rovning bir necha yozuvi: usage maksimum bilan bitta element, id barqaror', () => {
    const c = conv();
    const a1 = c.convertLine(line(assistant([text('birinchi')], { usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 5, cache_creation_input_tokens: 0 } })));
    const a2 = c.convertLine(line(assistant([toolUse('toolu_9', 'Read', { file_path: '/p/a.ts' })], { usage: { input_tokens: 10, output_tokens: 40, cache_read_input_tokens: 5, cache_creation_input_tokens: 3 } })));
    expect(a1.requestIds).toEqual(['req_A']);
    const usage = c.usageItems([...a1.requestIds, ...a2.requestIds]);
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ kind: 'usage', id: 'usage:req_A', requestId: 'req_A', outputTokens: 40, cacheCreationTokens: 3, model: 'claude-sonnet-5-5' });
    expect(a1.items[0]).toMatchObject({ kind: 'assistant', requestId: 'req_A', model: 'claude-sonnet-5-5' });
    expect(a2.items[0]).toMatchObject({ kind: 'tool_use', toolName: 'Read', summary: 'Read: /p/a.ts' });
  });

  it('thinking default o\'chiq, bayroq bilan yoqiladi', () => {
    const e = assistant([thinking('o\'ylayapman'), text('javob')]);
    expect(run(conv(false), e).map((i) => i.kind)).toEqual(['assistant']);
    expect(run(conv(true), e).map((i) => i.kind)).toEqual(['thinking', 'assistant']);
  });

  it('sintetik model tashlanadi, API xato xabari notice bo\'ladi', () => {
    expect(run(conv(), assistant([text('No response requested.')], { model: '<synthetic>' }))).toHaveLength(0);
    const err = run(conv(), assistant([text('API Error: 529 overloaded')], { model: '<synthetic>', extra: { isApiErrorMessage: true } }));
    expect(err[0]).toMatchObject({ kind: 'notice', code: 'error', level: 'error' });
  });

  it('compact boundary va xato tizim yozuvlari', () => {
    const items = run(conv(), system('compact_boundary'), system('turn_duration'), system('informational', { level: 'error', content: 'xato bo\'ldi' }));
    expect(items.map((i) => (i.kind === 'notice' ? i.code : i.kind))).toEqual(['compact', 'error']);
  });

  it('rad etilgan ruxsat: notice + xatoli tool_result', () => {
    const c = conv();
    run(c, assistant([toolUse('toolu_d', 'Bash', { command: 'rm -rf x' })]));
    const items = run(c, toolResult('toolu_d', "The user doesn't want to proceed with this tool use.", true));
    expect(items.map((i) => i.kind)).toEqual(['notice', 'tool_result']);
    expect(items[1]).toMatchObject({ ok: false });
  });
});

describe('tool qisqa ko\'rinishi', () => {
  it('Bash/Edit/Write/WebFetch/MCP', () => {
    expect(summarizeToolUse('Bash', { command: 'npm test\nsecond' }).summary).toBe('Bash: npm test …');
    expect(summarizeToolUse('Edit', { file_path: '/a.ts', old_string: 'a\nb', new_string: 'c\nd\ne' })).toEqual({ summary: 'Edit: /a.ts (+3 -2)', lines: { added: 3, removed: 2 } });
    expect(summarizeToolUse('Write', { file_path: '/a.ts', content: 'l1\nl2' }).lines).toEqual({ added: 2, removed: 0 });
    expect(summarizeToolUse('WebFetch', { url: 'https://x.dev/p?token=abc123' }).summary).toBe('WebFetch: https://x.dev/p');
    expect(summarizeToolUse('mcp__srv__do', { secret: 'S3cr3t' }).summary).toBe('mcp__srv__do');
  });

  it('summary uzunligi va redakt', () => {
    const s = summarizeToolUse('Bash', { command: 'curl -H "Authorization: Bearer abcdefghijklmnop1234" ' + 'x'.repeat(600) }).summary;
    expect(s.length).toBeLessThanOrEqual(300);
    expect(s).not.toContain('abcdefghijklmnop1234');
  });
});

describe('redakt va kesish (chat elementlarida)', () => {
  const LEAK = 'S3cr3tV4lue99';
  it('user/assistant matni, tool_use summary va tool_result sirlarni yashiradi', () => {
    const c = conv();
    const items = [
      ...run(c, userPrompt(`token: Bearer abcdefghijklmnop1234 va API_KEY=${LEAK}`)),
      ...run(c, assistant([text(`ghp_abcdefghijklmnopqrstuvwx1234 mana`), toolUse('toolu_s', 'Bash', { command: `export DB_PASSWORD=${LEAK}` })])),
      ...run(c, toolResult('toolu_s', `ok\nSMTP_HOST=mail.internal\n-----BEGIN PRIVATE KEY-----\nabc${LEAK}\n-----END PRIVATE KEY-----`)),
    ];
    const json = JSON.stringify(items);
    expect(json).not.toContain(LEAK);
    expect(json).not.toContain('abcdefghijklmnop1234');
    expect(json).not.toContain('abcdefghijklmnopqrstuvwx');
    expect(json).not.toContain('mail.internal');
  });

  it('.env o\'qigan tool natijasi butunlay yashiriladi', () => {
    const c = conv();
    run(c, assistant([toolUse('toolu_e', 'Read', { file_path: '/proj/.env' }), toolUse('toolu_f', 'Bash', { command: 'cat .env.local' })]));
    const a = run(c, toolResult('toolu_e', 'PLAIN_VALUE=qwerty'));
    const b = run(c, toolResult('toolu_f', 'OTHER=zzz'));
    expect(JSON.stringify([a, b])).not.toMatch(/qwerty|zzz/);
    expect(a[0]).toMatchObject({ kind: 'tool_result', text: expect.stringContaining('REDACTED') });
  });

  it('nozik yo\'l va buyruq aniqlash', () => {
    expect(isSensitivePath('/p/.env')).toBe(true);
    expect(isSensitivePath('C:\\Users\\x\\.ssh\\id_rsa')).toBe(true);
    expect(isSensitivePath('/p/.env.example')).toBe(false);
    expect(isSensitivePath('/p/src/env.ts')).toBe(false);
    expect(isSensitiveToolUse('Bash', { command: 'printenv' })).toBe(true);
    expect(isSensitiveToolUse('Bash', { command: 'cat ~/.aws/credentials' })).toBe(true);
    expect(isSensitiveToolUse('Bash', { command: 'npm test' })).toBe(false);
  });

  it('tool_result 4 KB bayt chegarasi (ko\'p baytli belgilar bo\'linmaydi)', () => {
    const c = conv();
    run(c, assistant([toolUse('toolu_b', 'Bash', { command: 'x' })]));
    const items = run(c, toolResult('toolu_b', 'ё'.repeat(6000)));
    const it = items[0]!;
    if (it.kind !== 'tool_result') throw new Error('kutilmagan');
    expect(Buffer.byteLength(it.text, 'utf8')).toBeLessThanOrEqual(4096);
    expect(it.truncated).toBe(true);
    expect(it.text).not.toContain('\uFFFD');
  });

  it('capBytes qisqa matnga tegmaydi', () => {
    expect(capBytes('abc', 10)).toEqual({ text: 'abc', truncated: false });
  });

  it('juda uzun assistant matni kesiladi (<= 16000 belgi)', () => {
    const items = run(conv(), assistant([text('a'.repeat(50_000))]));
    expect((items[0] as { text: string }).text.length).toBeLessThanOrEqual(16_000);
  });
});
