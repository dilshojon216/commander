import { describe, expect, it } from 'vitest';
import { buildRenderResponse, containsSecret, toTemplateDto } from './template-logic.js';
import type { TemplateRow } from './template-logic.js';

const row = (over: Partial<TemplateRow> = {}): TemplateRow => ({
  id: '8d5b9b6e-3c1d-4a43-9a53-6f6a4e5c1111', scope: 'global', project_id: null, project_name: null, repo_key: null, name: 'Review', description: null,
  body: 'Review {{project}} {{branch}} {{task_key}}', model: null, permission_mode: 'plan', builtin: false, created_by_device_id: null,
  created_at: new Date('2026-11-14T00:00:00Z'), updated_at: new Date('2026-11-14T00:00:00Z'), ...over,
});

describe('template-logic', () => {
  it('toTemplateDto: o\'zgaruvchilar ro\'yxati', () => {
    expect(toTemplateDto(row()).variables).toEqual(['project', 'branch', 'task_key']);
  });
  it('containsSecret', () => {
    expect(containsSecret('token=abcdef123456')).toBe(true);
    expect(containsSecret('sk-ant-abcdefghijklmnop')).toBe(true);
    expect(containsSecret('Testlarni yurgiz {{project}}')).toBe(false);
  });
  it('buildRenderResponse: to\'liq kontekst', () => {
    const r = buildRenderResponse(toTemplateDto(row()), { project: { name: 'commander', branch: 'main' }, taskKey: '3.4', date: '2026-11-14' });
    expect(r).toMatchObject({ text: 'Review commander main 3.4', missing: [], tooLong: false, length: 25, permissionMode: 'plan' });
    expect(r.variables).toEqual([{ name: 'project', value: 'commander' }, { name: 'branch', value: 'main' }, { name: 'task_key', value: '3.4' }]);
  });
  it('yetishmayotgan o\'zgaruvchi missing; matnda {{nom}} qoladi', () => {
    const r = buildRenderResponse(toTemplateDto(row()), { project: { name: 'commander', branch: null }, date: '2026-11-14' });
    expect(r.missing).toEqual(['branch', 'task_key']);
    expect(r.text).toBe('Review commander {{branch}} {{task_key}}');
    expect(r.variables.find((v) => v.name === 'branch')?.value).toBeNull();
  });
  it('tooLong: render natijasi chegaradan oshsa', () => {
    const r = buildRenderResponse(toTemplateDto(row({ body: `${'x'.repeat(15_990)} {{task_title}}` })), { taskKey: 'k', taskTitle: 'y'.repeat(100), date: '2026-11-14' });
    expect(r.tooLong).toBe(true);
  });
  it('qiymatdagi {{...}} qayta kengaytirilmaydi; loyiha nomi yangi qator bilan buzilmaydi', () => {
    const r = buildRenderResponse(toTemplateDto(row({ body: '{{project}}|{{task_title}}' })), { project: { name: 'a\nb', branch: null }, taskTitle: '{{branch}}', date: '2026-11-14' });
    expect(r.text).toBe('a b|{{branch}}');
  });
});
