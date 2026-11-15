import { describe, expect, it } from 'vitest';
import type { CommandDto } from '@commander/contracts';
import { formatResumeCloseResult } from './resume-format.js';

const dto = (over: Partial<CommandDto>): CommandDto => ({ status: 'done', errorCode: null, result: null, ...over }) as CommandDto;

describe('6.14 Telegram natija matnlari', () => {
  it('davom ettirish: tmux attach buyrug\'i (HTML-escape)', () => {
    const t = formatResumeCloseResult(dto({ result: { tmuxSession: 'cmdr-a1b97ff9' } }), true);
    expect(t).toContain('<code>tmux attach -t cmdr-a1b97ff9</code>');
    expect(t).toContain('✅');
  });
  it('xatolar o\'zbekcha: tirik sessiya, Windows, nusxa; kutilmoqda', () => {
    expect(formatResumeCloseResult(dto({ status: 'rejected', errorCode: 'session_still_running' }), true)).toContain('Sessiya hali terminalda ochiq — avval undan chiqing');
    expect(formatResumeCloseResult(dto({ status: 'rejected', errorCode: 'resume_unsupported' }), true)).toContain('Windows');
    expect(formatResumeCloseResult(dto({ status: 'failed', errorCode: 'resume_forked' }), true)).toContain('nusxa');
    expect(formatResumeCloseResult(dto({ status: 'failed', errorCode: 'close_failed' }), false)).toContain('Yopilmadi');
    expect(formatResumeCloseResult(dto({ status: 'running' }), false)).toContain('⏳');
  });
  it('yopish: agent izohi', () => {
    expect(formatResumeCloseResult(dto({ result: { detail: 'exited gracefully (/exit)' } }), false)).toContain('exited gracefully');
  });
});
