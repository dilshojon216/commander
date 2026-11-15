import { describe, expect, it } from 'vitest';
import { ConfigChunkBuffer, allowEntryProblem, checkConfigPath, checkSettingsFragment, envKeyProblem, normalizeSettingsFragment } from './config-sync.js';

const h = 'a'.repeat(64);

describe('checkConfigPath', () => {
  it('ruxsat etilgan yo\'llar', () => {
    expect(checkConfigPath('CLAUDE.md')).toEqual({ ok: true, kind: 'claude_md' });
    expect(checkConfigPath('agents/x.md')).toEqual({ ok: true, kind: 'agent' });
    expect(checkConfigPath('commands/x.md')).toEqual({ ok: true, kind: 'command' });
    expect(checkConfigPath('skills/s/SKILL.md')).toEqual({ ok: true, kind: 'skill' });
    expect(checkConfigPath('skills/s/scripts/run.sh')).toEqual({ ok: true, kind: 'skill' });
  });
  it('rad etiladiganlar', () => {
    for (const p of ['', '/abs.md', '../x', 'agents/../x.md', 'agents/x.txt', 'agents/sub/x.md', 'commands/a/b.md', 'skills/s.md', 'skills/s/img.png', 'skills/s/.env', 'settings.json', 'agents\\x.md', 'agents/nul.md', 'agents/COM1.md', 'agents/x.md.', 'agents/a b.md', 'C:/x.md', 'agents/x:y.md', 'CLAUDE.md/x']) {
      expect(checkConfigPath(p).ok, p).toBe(false);
    }
  });
});

describe('settings tekshiruvi', () => {
  it('allow yozuvlari', () => {
    expect(allowEntryProblem('Bash(npm test:*)')).toBeNull();
    expect(allowEntryProblem('Read')).toBeNull();
    expect(allowEntryProblem('mcp__commander__commander_send')).toBeNull();
    for (const e of ['*', 'Bash', 'Bash(*)', 'Bash(:*)', 'Edit(**)', 'mcp__*', 'Write', '(x)']) expect(allowEntryProblem(e), e).not.toBeNull();
  });
  it('env kalitlari', () => {
    expect(envKeyProblem('BASH_DEFAULT_TIMEOUT_MS')).toBeNull();
    for (const k of ['ANTHROPIC_BASE_URL', 'COMMANDER_URL', 'OTEL_EXPORTER', 'MY_TOKEN', 'HTTPS_PROXY', 'PATH', 'lower', 'NODE_OPTIONS']) expect(envKeyProblem(k), k).not.toBeNull();
  });
  it('fragment muammolari qiymatni oshkor qilmaydi', () => {
    const p = checkSettingsFragment({ permissions: { allow: ['Bash(*)'], deny: [] }, env: { FOO: 'sk-secret-value-1234567890abc' } }, (t) => t.includes('sk-'));
    expect(p.length).toBe(2);
    expect(JSON.stringify(p)).not.toContain('sk-secret');
  });
  it('normalizatsiya takrorsiz va saralangan', () => {
    expect(normalizeSettingsFragment({ permissions: { allow: ['b', 'a', 'b'], deny: [] }, env: {} }).permissions.allow).toEqual(['a', 'b']);
  });
});

describe('ConfigChunkBuffer', () => {
  const c = (seq: number, total = 2, id = h) => ({ transferId: id, seq, total, data: 'QQ==' });
  it('to\'liq bo\'lgach tartib bilan beradi', () => {
    const b = new ConfigChunkBuffer();
    b.add(c(1), 0);
    expect(b.get(h, 2)).toBeUndefined();
    b.add(c(0), 0);
    b.add(c(0), 0);
    expect(b.get(h, 2)).toHaveLength(2);
    b.delete(h);
    expect(b.size()).toBe(0);
  });
  it('muddat, total nomuvofiqligi va hajm chegarasi', () => {
    const b = new ConfigChunkBuffer(10, 1000);
    expect(b.add(c(0), 0)).toBe(true);
    expect(b.add(c(1, 3), 1)).toBe(false);
    b.prune(5000);
    expect(b.size()).toBe(0);
    const small = new ConfigChunkBuffer(5, 1000);
    expect(small.add({ ...c(0), data: 'AAAAAAAAAA' }, 0)).toBe(false);
  });
});

describe('M-07: permissions.allow interpretator/shell va himoyalangan yo\'llarni rad etadi', () => {
  it.each([
    'Bash(bash:*)', 'Bash(sh -c:*)', 'Bash(python3:*)', 'Bash(node:*)', 'Bash(curl:*)', 'Bash(wget https://x:*)', 'Bash(ssh:*)', 'Bash(sudo:*)', 'Bash(env:*)', 'Bash(xargs:*)', 'Bash(/bin/bash:*)', 'Bash(npx:*)', 'Bash(eval:*)', 'Bash(PERL:*)',
    'Edit(~/.claude/**)', 'Write(~/.commander/**)', 'Read(~/.ssh/**)', 'Edit(.claude/settings.json)', 'Read(/Users/x/.aws/credentials)', 'MultiEdit(**/.git/hooks/*)',
  ])('%s rad etiladi', (entry) => {
    expect(allowEntryProblem(entry)).not.toBeNull();
  });
  it.each(['Bash(npm test:*)', 'Bash(git status:*)', 'Bash(ls:*)', 'Bash(cargo build:*)', 'Edit(src/**)', 'Read(docs/**)', 'Write(./out/**)', 'Bash(git diff:*)'])('%s ruxsat etiladi', (entry) => {
    expect(allowEntryProblem(entry)).toBeNull();
  });
});
