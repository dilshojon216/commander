import { describe, expect, it } from 'vitest';
import { CreateTemplateBodySchema, UpdateTemplateBodySchema } from './templates.js';
import { extractTemplateVariables, renderTemplate, sanitizeTemplateValue } from './template-render.js';

describe('renderTemplate', () => {
  it('o\'zgaruvchilarni almashtiradi (bo\'sh joy bilan ham)', () => {
    const r = renderTemplate('Vazifa {{task_key}}: {{ task_title }} ({{project}}, {{branch}}, {{date}})', {
      task_key: '3.4',
      task_title: 'Shablonlar',
      project: 'commander',
      branch: 'main',
      date: '2026-11-14',
    });
    expect(r.text).toBe('Vazifa 3.4: Shablonlar (commander, main, 2026-11-14)');
    expect(r.missing).toEqual([]);
    expect(r.used).toEqual(['task_key', 'task_title', 'project', 'branch', 'date']);
  });

  it('qiymati yo\'q o\'zgaruvchi matnda qoladi va missing\'ga tushadi', () => {
    const r = renderTemplate('A {{task_key}} B {{branch}} C {{task_key}}', { branch: 'dev', task_key: '  ' });
    expect(r.text).toBe('A {{task_key}} B dev C {{task_key}}');
    expect(r.missing).toEqual(['task_key']);
  });

  it('noma\'lum nom missing; escape `\\{{` literal bo\'ladi', () => {
    const r = renderTemplate('{{secret}} \\{{project}} {{project}}', { project: 'p' });
    expect(r.text).toBe('{{secret}} {{project}} p');
    expect(r.missing).toEqual(['secret']);
  });

  it('qiymat ichidagi {{...}} qayta kengaytirilmaydi (bir o\'tish)', () => {
    const r = renderTemplate('T: {{task_title}} / {{project}}', { task_title: '{{project}} {{task_key}}', project: 'SECRET', task_key: 'x' });
    expect(r.text).toBe('T: {{project}} {{task_key}} / SECRET');
  });

  it('qiymat yangi qatorlarsiz va uzunlik cheklangan', () => {
    expect(sanitizeTemplateValue('task_title', 'a\nb\r\nc\u0007d')).toBe('a b cd');
    expect(Array.from(sanitizeTemplateValue('task_key', 'x'.repeat(100)))).toHaveLength(64);
    expect(sanitizeTemplateValue('branch', '  feat/x  ')).toBe('feat/x');
  });

  it('o\'zgaruvchi chiqarish: takrorsiz, escape hisobga olinmaydi', () => {
    expect(extractTemplateVariables('{{date}} {{date}} \\{{branch}} {{nope}} {{ project }}')).toEqual({ known: ['date', 'project'], unknown: ['nope'] });
  });
});

describe('Template sxemalari', () => {
  const base = { name: 'Review', body: 'Review {{project}}' };
  it('ko\'lam qoidalari', () => {
    expect(CreateTemplateBodySchema.safeParse({ ...base, scope: 'global' }).success).toBe(true);
    expect(CreateTemplateBodySchema.safeParse({ ...base, scope: 'project' }).success).toBe(false);
    expect(CreateTemplateBodySchema.safeParse({ ...base, scope: 'project', projectId: '8d5b9b6e-3c1d-4a43-9a53-6f6a4e5c1111' }).success).toBe(true);
    expect(CreateTemplateBodySchema.safeParse({ ...base, scope: 'global', projectId: '8d5b9b6e-3c1d-4a43-9a53-6f6a4e5c1111' }).success).toBe(false);
    expect(CreateTemplateBodySchema.safeParse({ ...base, scope: 'repo' }).success).toBe(false);
    expect(CreateTemplateBodySchema.safeParse({ ...base, scope: 'repo', repoKey: 'github.com/o/r' }).success).toBe(true);
  });
  it('noma\'lum o\'zgaruvchi, bo\'sh matn, bypassPermissions rad', () => {
    expect(CreateTemplateBodySchema.safeParse({ ...base, scope: 'global', body: 'x {{nope}}' }).success).toBe(false);
    expect(CreateTemplateBodySchema.safeParse({ ...base, scope: 'global', body: '   ' }).success).toBe(false);
    expect(CreateTemplateBodySchema.safeParse({ ...base, scope: 'global', permissionMode: 'bypassPermissions' }).success).toBe(false);
    expect(CreateTemplateBodySchema.safeParse({ ...base, scope: 'global', permissionMode: 'plan', model: 'haiku' }).success).toBe(true);
  });
  it('update: bo\'sh tana rad, null bilan tozalash mumkin', () => {
    expect(UpdateTemplateBodySchema.safeParse({}).success).toBe(false);
    expect(UpdateTemplateBodySchema.safeParse({ model: null, permissionMode: null }).success).toBe(true);
    expect(UpdateTemplateBodySchema.safeParse({ scope: 'global' }).success).toBe(false);
  });
});
