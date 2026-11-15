import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SUMMARY_LIMITS } from '@commander/contracts';
import { buildSummaryInput, readTranscriptItems } from './session-summary-input.js';

const SECRET = 'sk-ant-api03-SUPERSECRETVALUE1234567890abcdef';
let n = 0;
const user = (text: string): string => JSON.stringify({ type: 'user', uuid: `u${++n}`, timestamp: '2026-11-14T10:00:00Z', message: { role: 'user', content: text } });
const assistant = (blocks: unknown[], rid = `r${n}`, usage = { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 9999, cache_creation_input_tokens: 10 }): string =>
  JSON.stringify({ type: 'assistant', uuid: `a${++n}`, requestId: rid, timestamp: '2026-11-14T10:00:05Z', message: { id: `m${n}`, model: 'claude-x', content: blocks, usage } });
const toolResult = (id: string, content: string): string =>
  JSON.stringify({ type: 'user', uuid: `u${++n}`, timestamp: '2026-11-14T10:00:06Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] } });

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sumin-'));
  n = 0;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function build(lines: string[], project = 'api') {
  const f = join(dir, 't.jsonl');
  writeFileSync(f, lines.join('\n') + '\n');
  const r = await readTranscriptItems(f);
  expect(r).not.toBeNull();
  return buildSummaryInput(r!.items, project);
}

describe('buildSummaryInput', () => {
  it('uses first lines of prompts, tool summaries, changed files, the last assistant message and counts prompts/tokens', async () => {
    const out = await build([
      user('Login xatosini tuzat\nikkinchi qator bu yerda ko\'rinmasligi kerak'),
      assistant([{ type: 'text', text: 'Boshladim' }, { type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: 'src/auth.ts', old_string: 'a', new_string: 'b\nc' } }]),
      toolResult('t1', 'XOM NATIJA MATNI'),
      user('Testlarni ham yoz'),
      assistant([{ type: 'text', text: 'Tayyor, testlar qo\'shildi.' }, { type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'npm test' } }]),
    ]);
    expect(out.stats.promptCount).toBe(2);
    expect(out.stats.tokens).toBe(2 * (100 + 50 + 10)); // kesh o'qish hisobga olinmaydi
    expect(out.input.prompts).toEqual(['Login xatosini tuzat', 'Testlarni ham yoz']);
    expect(out.input.files).toEqual(['src/auth.ts']);
    expect(out.input.tools).toContain('Edit: src/auth.ts (+2 -1)');
    expect(out.input.tools).toContain('Bash: npm test');
    expect(out.input.lastAssistant).toBe("Tayyor, testlar qo'shildi.");
    expect(out.prompt).toContain('Login xatosini tuzat');
    expect(out.prompt).not.toContain("ko'rinmasligi kerak");
  });

  it('NEVER includes raw tool results, thinking, or secrets (prompt, tool input, assistant text)', async () => {
    const out = await build([
      user(`Kalit ${SECRET} bilan ulan`),
      assistant([
        { type: 'thinking', thinking: 'MAXFIY FIKRLASH' },
        { type: 'text', text: `Kalit ${SECRET} ishlatildi` },
        { type: 'tool_use', id: 't1', name: 'Bash', input: { command: `curl -H "Authorization: Bearer ${SECRET}" https://x.test` } },
        { type: 'tool_use', id: 't2', name: 'Read', input: { file_path: '/home/u/app/.env' } },
        { type: 'tool_use', id: 't3', name: 'Bash', input: { command: 'cat .env' } },
      ]),
      toolResult('t1', `RESPONSE_BODY token=${SECRET}`),
      toolResult('t2', `DB_PASSWORD=hunter2 SMTP_HOST=mail.local`),
    ]);
    const all = JSON.stringify(out.input) + out.prompt;
    expect(all).not.toContain(SECRET);
    expect(all).not.toContain('SUPERSECRETVALUE');
    expect(all).not.toContain('RESPONSE_BODY');
    expect(all).not.toContain('hunter2');
    expect(all).not.toContain('MAXFIY FIKRLASH');
    expect(all).not.toContain('.env');
    expect(all).toContain('[REDACTED]');
  });

  it('caps the whole input at inputMaxChars even for huge transcripts', async () => {
    const lines: string[] = [];
    for (let i = 0; i < 80; i++) {
      lines.push(user(`${'so\'rov '.repeat(80)} ${i}`));
      lines.push(assistant([{ type: 'text', text: 'x'.repeat(8000) }, ...Array.from({ length: 6 }, (_, k) => ({ type: 'tool_use', id: `t${i}-${k}`, name: 'Edit', input: { file_path: `src/f${i}-${k}-${'d'.repeat(120)}.ts`, old_string: 'a', new_string: 'b' } }))]));
    }
    const out = await build(lines);
    expect(out.prompt.length).toBeLessThanOrEqual(SUMMARY_LIMITS.inputMaxChars);
    expect(out.stats.promptCount).toBe(80);
    expect(out.input.files.length).toBeLessThanOrEqual(SUMMARY_LIMITS.filesMaxItems);
    expect(out.input.lastAssistant.length).toBeLessThanOrEqual(3000);
  });

  it('ignores shell/task user variants and unreadable files', async () => {
    const out = await build([JSON.stringify({ type: 'user', uuid: 'x1', message: { content: '<bash-input>ls</bash-input>' } }), user('Haqiqiy prompt')]);
    expect(out.stats.promptCount).toBe(1);
    expect(await readTranscriptItems(join(dir, 'yoq.jsonl'))).toBeNull();
  });
});
