import { describe, expect, it } from 'vitest';
import { decideConfigPolicy } from './config-policy.js';
import { DISABLED_POLICY, decidePolicy } from './policy.js';

describe('config siyosati', () => {
  it('default o\'chiq', () => {
    expect(DISABLED_POLICY.remote.allowConfigRead).toBe(false);
    expect(DISABLED_POLICY.remote.allowConfigWrite).toBe(false);
  });
  it('o\'qish faqat capture va dry-run uchun', () => {
    const r = { allowConfigRead: true, allowConfigWrite: false };
    expect(decideConfigPolicy('config.capture', r, false).ok).toBe(true);
    expect(decideConfigPolicy('config.apply', r, true).ok).toBe(true);
    expect(decideConfigPolicy('config.apply', r, false)).toMatchObject({ ok: false, code: 'config_not_allowed' });
    expect(decideConfigPolicy('config.rollback', r, false)).toMatchObject({ ok: false, code: 'config_not_allowed' });
  });
  it('decidePolicy: remote o\'chiq yoki root bo\'lsa config ham rad', () => {
    const on = { remote: { ...DISABLED_POLICY.remote, enabled: true, allowConfigRead: true, allowConfigWrite: true } };
    expect(decidePolicy({ type: 'config.apply', policy: on, runningAsRoot: false, dryRun: false }).ok).toBe(true);
    expect(decidePolicy({ type: 'config.apply', policy: on, runningAsRoot: true, dryRun: false })).toMatchObject({ code: 'running_as_root' });
    expect(decidePolicy({ type: 'config.capture', policy: DISABLED_POLICY, runningAsRoot: false })).toMatchObject({ code: 'policy_disabled' });
  });
});
