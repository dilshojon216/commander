import { describe, expect, it } from 'vitest';
import { CreateApprovalRuleBodySchema, isRuleToolAllowed, validatePathGlob } from './approval-rules.js';

const SESSION = '0b7f3c1e-9d2a-4c55-8f10-aa11bb22cc33';
const ok = (over: Record<string, unknown> = {}) => CreateApprovalRuleBodySchema.safeParse({ scope: 'session', scopeRef: SESSION, tools: ['Edit', 'Write'], ttlSeconds: 3600, ...over });

describe('isRuleToolAllowed', () => {
  it("fayl vositalari va aniq MCP nomlari ruxsat; Bash/shell/Task/Agent/WebFetch/ExitPlanMode va noma'lum emas", () => {
    for (const t of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Read', 'Glob', 'Grep', 'mcp__figma__get_screenshot']) expect(isRuleToolAllowed(t), t).toBe(true);
    for (const t of ['Bash', 'bash', 'BashOutput', 'KillShell', 'PowerShell', 'Task', 'Agent', 'WebFetch', 'WebSearch', 'ExitPlanMode', 'Skill', 'Unknown', 'mcp__*__*', 'mcp__a', 'mcp__a__b c']) expect(isRuleToolAllowed(t), t).toBe(false);
    for (const t of ['mcp__sh__run_command', 'mcp__term__exec', 'mcp__x__execute_script', 'mcp__k__kubectl_apply', 'mcp__a__bash']) expect(isRuleToolAllowed(t), t).toBe(false);
  });
});

describe('validatePathGlob', () => {
  it('yaroqli va yaroqsiz glob', () => {
    for (const g of ['src/**', 'src/**/*.ts', '*.md', 'docs/a?.md', 'my dir/x']) expect(validatePathGlob(g), g).toBeNull();
    for (const g of ['', '/etc/**', '../x', 'a/../b', 'a//b', 'a\\b', 'C:/x', 'a/./b', '..', 'src/{a,b}', 'x'.repeat(201)]) expect(validatePathGlob(g), g).not.toBeNull();
  });
});

describe('CreateApprovalRuleBodySchema', () => {
  it('to\'g\'ri tana', () => {
    const r = ok({ pathGlobs: ['src/**'] });
    expect(r.success).toBe(true);
  });
  it('muddat majburiy va 60 s..7 kun', () => {
    expect(ok({ ttlSeconds: undefined }).success).toBe(false);
    expect(ok({ ttlSeconds: 59 }).success).toBe(false);
    expect(ok({ ttlSeconds: 7 * 24 * 3600 }).success).toBe(true);
    expect(ok({ ttlSeconds: 7 * 24 * 3600 + 1 }).success).toBe(false);
  });
  it('Bash, Task/Agent, noma\'lum vosita yoki wildcard rad etiladi', () => {
    for (const tools of [['Bash'], ['Edit', 'Bash'], ['Task'], ['Agent'], ['Foo'], ['mcp__*'], []]) expect(ok({ tools }).success, JSON.stringify(tools)).toBe(false);
  });
  it('pathGlobs faqat fayl vositalari uchun; takror vosita rad', () => {
    expect(ok({ tools: ['mcp__a__b'], pathGlobs: ['src/**'] }).success).toBe(false);
    expect(ok({ tools: ['Edit', 'mcp__a__b'], pathGlobs: ['src/**'] }).success).toBe(false);
    expect(ok({ tools: ['Edit', 'Edit'] }).success).toBe(false);
  });
  it('scopeRef: session/project uuid, repo ixtiyoriy matn; noma\'lum maydon rad', () => {
    expect(ok({ scopeRef: 'abc' }).success).toBe(false);
    expect(ok({ scope: 'repo', scopeRef: 'github.com/a/b' }).success).toBe(true);
    expect(ok({ extra: 1 }).success).toBe(false);
  });
});
