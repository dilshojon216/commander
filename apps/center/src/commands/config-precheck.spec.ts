import { describe, expect, it } from 'vitest';
import type { AgentControlState } from '@commander/contracts';
import { configNeedsStepUp, precheckConfig } from './config-precheck.js';

const ctl = (o: Partial<AgentControlState>): AgentControlState => ({ enabled: true, allowStart: true, allowPrompt: true, allowStop: true, allowSetMode: true, allowAutoMode: false, maxConcurrentStarted: 3, allowedRootCount: 0, centerKeyPinned: true, runningAsRoot: false, ...o });

describe('config precheck', () => {
  it('eski agentd', () => expect(precheckConfig('config.capture', ctl({}), false)?.code).toBe('agent_outdated'));
  it('o\'qish/yozish bayroqlari', () => {
    const ro = ctl({ configSync: true, allowConfigRead: true, allowConfigWrite: false });
    expect(precheckConfig('config.capture', ro, false)).toBeNull();
    expect(precheckConfig('config.apply', ro, true)).toBeNull();
    expect(precheckConfig('config.apply', ro, false)?.code).toBe('config_not_allowed');
    expect(precheckConfig('config.rollback', ro, false)?.code).toBe('config_not_allowed');
    expect(precheckConfig('config.capture', ctl({ configSync: true }), false)?.code).toBe('config_not_allowed');
  });
  it('step-up faqat haqiqiy yozuvda', () => {
    expect(configNeedsStepUp('config.capture', false)).toBe(false);
    expect(configNeedsStepUp('config.apply', true)).toBe(false);
    expect(configNeedsStepUp('config.apply', false)).toBe(true);
    expect(configNeedsStepUp('config.rollback', false)).toBe(true);
  });
});
