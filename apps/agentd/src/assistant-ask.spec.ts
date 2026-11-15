import { describe, expect, it } from 'vitest';
import { AssistantOps } from './assistant-ask.js';
import { haikuArgs, parseClaudeResult } from './haiku-oneshot.js';
import type { Logger } from './logger.js';

const log: Logger = { debug() {}, info() {}, warn() {}, error() {}, child() { return log; } } as unknown as Logger;
const out = (result: string, isError = false): string => JSON.stringify([{ type: 'system', model: 'claude-haiku-5' }, { type: 'result', is_error: isError, result, usage: { input_tokens: 10, output_tokens: 5 } }]);

function ops(stdout: string | Error) {
  const calls: string[][] = [];
  const o = new AssistantOps({
    claudeBin: 'claude',
    dir: '/tmp/commander-test-empty',
    log,
    exec: async (args) => {
      calls.push(args);
      if (stdout instanceof Error) throw stdout;
      return stdout;
    },
  });
  return { o, calls };
}

describe('haiku one-shot', () => {
  it('uses the safe flag set (no tools, local settings only, no session persistence, slash commands off)', () => {
    const a = haikuArgs('SYS', 'PROMPT');
    expect(a.slice(0, 2)).toEqual(['-p', '--model']);
    expect(a[a.indexOf('--tools') + 1]).toBe('');
    expect(a[a.indexOf('--setting-sources') + 1]).toBe('local');
    expect(a).toContain('--no-session-persistence');
    expect(a).toContain('--disable-slash-commands');
    expect(a.slice(-2)).toEqual(['--', 'PROMPT']);
  });

  it('parses result, model and token usage', () => {
    expect(parseClaudeResult(out('hi'))).toEqual({ text: 'hi', isError: false, model: 'claude-haiku-5', tokens: 15 });
    expect(parseClaudeResult('not json')).toBeNull();
  });
});

describe('AssistantOps.ask', () => {
  const payload = { question: 'Bugun nima qilindi?', context: '[S1] session api: login tuzatildi' };

  it('returns the redacted answer and the cited source ids; the prompt carries question and context only', async () => {
    const { o, calls } = ops(out('{"answer":"Login tuzatildi. Kalit sk-ant-api03-ABCDEFGH1234567890XYZ","sources":["S1","S9x"]}'));
    const r = await o.ask(payload);
    expect(r.ok).toBe(true);
    const a = (r.result as { assistant: { answer: string; sources: string[]; model: string } }).assistant;
    expect(a.sources).toEqual(['S1']);
    expect(a.answer).toContain('[REDACTED]');
    expect(a.answer).not.toContain('ABCDEFGH1234567890');
    expect(a.model).toBe('claude-haiku-5');
    const prompt = calls[0]![calls[0]!.length - 1]!;
    expect(prompt).toContain('[S1] session api: login tuzatildi');
    expect(prompt).toContain('SAVOL: Bugun nima qilindi?');
  });

  it('rejects a malformed payload, a failing claude and an error result', async () => {
    expect((await ops(out('x')).o.ask({ question: '', context: 'c' })).code).toBe('invalid_payload');
    expect((await ops(new Error('boom')).o.ask(payload)).code).toBe('ask_failed');
    expect((await ops(out('x', true)).o.ask(payload)).code).toBe('ask_failed');
    expect((await ops(out('   ')).o.ask(payload)).code).toBe('ask_failed');
  });
});
