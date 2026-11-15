import { describe, expect, it } from 'vitest';
import { InvestigateBodySchema, OPS_FOLDER_HOWTO, OpsFolderPathSchema, PutInvestigationSettingsBodySchema, investigationErrorHint } from './index.js';

const ID = '123e4567-e89b-42d3-a456-426614174000';

describe('investigations kontrakti', () => {
  it('tana qat\'iy: faqat kind/id/model', () => {
    expect(InvestigateBodySchema.safeParse({ kind: 'health', id: ID }).success).toBe(true);
    expect(InvestigateBodySchema.safeParse({ kind: 'watchdog', id: ID, model: 'sonnet' }).success).toBe(true);
    expect(InvestigateBodySchema.safeParse({ kind: 'health', id: ID, permissionMode: 'auto' }).success).toBe(false);
    expect(InvestigateBodySchema.safeParse({ kind: 'health', id: ID, cwd: '/etc' }).success).toBe(false);
    expect(InvestigateBodySchema.safeParse({ kind: 'center', id: ID }).success).toBe(false);
    expect(InvestigateBodySchema.safeParse({ kind: 'health', id: ID, model: '--evil' }).success).toBe(false);
  });
  it('ops papka yo\'li: mutlaq, ".." va NUL yo\'q', () => {
    expect(OpsFolderPathSchema.safeParse('/Users/x/working/ops-notes').success).toBe(true);
    expect(OpsFolderPathSchema.safeParse('C:\\ops').success).toBe(true);
    for (const p of ['ops', '~/ops', '/a/../b', '/a\0b', '']) expect(OpsFolderPathSchema.safeParse(p).success, p).toBe(false);
    expect(PutInvestigationSettingsBodySchema.safeParse({ opsFolders: { [ID]: null } }).success).toBe(true);
    expect(PutInvestigationSettingsBodySchema.safeParse({ opsFolders: { notuuid: '/x' } }).success).toBe(false);
  });
  it('xato tushuntirishlari', () => {
    expect(investigationErrorHint('ops_folder_not_configured')).toBe(OPS_FOLDER_HOWTO);
    expect(investigationErrorHint('cwd_invalid', '/ops')).toContain('/ops');
    expect(investigationErrorHint('cwd_not_allowed')).toContain('allow-root');
    expect(investigationErrorHint('whatever')).toContain('ochilmadi');
    expect(investigationErrorHint(null)).toContain('ochilmadi');
  });
});
